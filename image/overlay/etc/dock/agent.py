#!/usr/bin/python3 -IS
"""Dock guest agent.

Runs inside the VM and multiplexes terminal sessions and background jobs over the
second serial port (ttyS1), so the host page can run several things at once.

Wire format, both directions:  type:u8  channel:u16le  length:u32le  payload
Host -> guest:  OPEN (json), DATA, RESIZE (rows:u16 cols:u16), CLOSE, PING, SYNC, SIGNAL (u8),
                CONNECT (json: tcp connection to a port inside the VM, for app previews),
                EOF (close the input of a session opened with stdin: true)
Guest -> host:  READY (json), DATA, EXIT (code:i32), PONG, SYNCED
"""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import socket
import struct
import termios
import time
import tty

T_OPEN, T_DATA, T_RESIZE, T_CLOSE, T_PING, T_SYNC, T_SIGNAL, T_CONNECT, T_EOF = 1, 2, 3, 4, 5, 6, 7, 8, 9
R_READY, R_DATA, R_EXIT, R_PONG, R_SYNCED = 65, 66, 67, 68, 69
HEADER = struct.Struct("<BHI")

BASE_ENV = {
    "HOME": "/root", "USER": "root", "LOGNAME": "root", "SHELL": "/bin/bash",
    "TERM": "xterm-256color", "LANG": "C.UTF-8",
    "PATH": "/dock/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
}

port = os.open("/dev/ttyS1", os.O_RDWR | os.O_NOCTTY)
tty.setraw(port)
sessions = {}  # channel -> Session
by_pid = {}
wake_r, wake_w = os.pipe()
os.set_blocking(wake_w, False)
os.set_blocking(wake_r, False)
signal.signal(signal.SIGCHLD, lambda *_: None)
signal.set_wakeup_fd(wake_w)


def send(kind, channel, payload=b""):
    data = HEADER.pack(kind, channel, len(payload)) + payload
    while data:
        try:
            n = os.write(port, data)
        except InterruptedError:
            continue
        data = data[n:]


class Session:
    def __init__(self, channel, pid, fd):
        self.channel, self.pid, self.fd = channel, pid, fd
        self.wfd = fd  # where input is written; a separate pipe for stdin: true
        self.close_input = False
        self.outbox = bytearray()  # bytes waiting to be written to the process
        self.code = None
        self.kill_at = None
        self.eof = False
        self.sock = None  # set for CONNECT sessions
        self.connecting = False


def set_size(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def open_session(channel, spec):
    if channel in sessions:
        return
    env = dict(BASE_ENV)
    env.update(spec.get("env") or {})
    if spec.get("script") is not None:
        argv = ["/bin/bash", "-lc", spec["script"]]
    else:
        argv = spec.get("argv") or ["/bin/bash", "-l"]
    cwd = spec.get("cwd") or "/root"
    use_pty = spec.get("pty", True)
    if use_pty:
        pid, fd = pty.fork()
    else:
        read_end, write_end = os.pipe()
        in_read, in_write = os.pipe() if spec.get("stdin") else (None, None)
        pid = os.fork()
        if pid == 0:
            os.setsid()
            os.dup2(in_read if in_read is not None else os.open("/dev/null", os.O_RDONLY), 0)
            os.dup2(write_end, 1)
            os.dup2(write_end, 2)
        else:
            os.close(write_end)
            fd = read_end
            if in_read is not None:
                os.close(in_read)
    if pid == 0:
        try:
            os.closerange(3, 256)
            signal.signal(signal.SIGCHLD, signal.SIG_DFL)
            try:
                os.chdir(cwd)
            except OSError:
                os.chdir("/")
            os.execvpe(argv[0], argv, env)
        except BaseException as exc:  # noqa: BLE001 - must never return into the agent loop
            os.write(2, ("dock: cannot start %s: %s\n" % (argv[0], exc)).encode())
        os._exit(127)
    if use_pty:
        set_size(fd, int(spec.get("rows") or 24), int(spec.get("cols") or 80))
    os.set_blocking(fd, False)
    session = Session(channel, pid, fd)
    if not use_pty and in_write is not None:
        os.set_blocking(in_write, False)
        session.wfd = in_write
    elif not use_pty:
        session.wfd = None
    sessions[channel] = session
    by_pid[pid] = session


def open_socket(channel, spec):
    if channel in sessions:
        return
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setblocking(False)
    try:
        sock.connect((spec.get("host") or "127.0.0.1", int(spec["port"])))
    except BlockingIOError:
        pass
    session = Session(channel, 0, sock.fileno())
    session.sock = sock
    session.connecting = True
    sessions[channel] = session


def finish(session):
    """The session's main process has exited: forward remaining output and report."""
    if session.sock is not None:
        try:
            session.sock.close()
        except OSError:
            pass
        sessions.pop(session.channel, None)
        send(R_EXIT, session.channel, struct.pack("<i", session.code or 0))
        return
    deadline = time.monotonic() + 0.5
    while time.monotonic() < deadline:
        try:
            chunk = os.read(session.fd, 4096)
        except BlockingIOError:
            break
        except OSError:
            break
        if not chunk:
            break
        send(R_DATA, session.channel, chunk)
    for fd in {session.fd, session.wfd} - {None}:
        try:
            os.close(fd)
        except OSError:
            pass
    sessions.pop(session.channel, None)
    by_pid.pop(session.pid, None)
    send(R_EXIT, session.channel, struct.pack("<i", session.code))


def reap():
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return
        session = by_pid.get(pid)
        if session:
            session.code = os.waitstatus_to_exitcode(status)
            if session.code < 0:
                session.code = 128 - session.code
            finish(session)


def signal_session(session, signum):
    if session.sock is not None:
        return
    try:
        os.killpg(session.pid, signum)
    except OSError:
        try:
            os.kill(session.pid, signum)
        except OSError:
            pass


def handle(kind, channel, payload):
    if kind == T_OPEN:
        try:
            open_session(channel, json.loads(payload.decode()))
        except Exception as exc:  # noqa: BLE001
            send(R_DATA, channel, ("dock: %s\n" % exc).encode())
            send(R_EXIT, channel, struct.pack("<i", 126))
    elif kind == T_CONNECT:
        try:
            open_socket(channel, json.loads(payload.decode()))
        except Exception:  # noqa: BLE001
            send(R_EXIT, channel, struct.pack("<i", 1))
    elif kind == T_PING:
        send(R_PONG, channel, payload)
    elif kind == T_SYNC:
        os.sync()
        send(R_SYNCED, channel, payload)
    else:
        session = sessions.get(channel)
        if not session:
            return
        if kind == T_DATA:
            if session.wfd is not None:
                session.outbox += payload
        elif kind == T_EOF:
            session.close_input = True
        elif kind == T_RESIZE and len(payload) >= 4:
            rows, cols = struct.unpack("<HH", payload[:4])
            set_size(session.fd, rows, cols)
        elif kind == T_SIGNAL and payload:
            signal_session(session, payload[0])
        elif kind == T_CLOSE and session.sock is not None:
            session.code = 0
            finish(session)
        elif kind == T_CLOSE:
            signal_session(session, signal.SIGHUP)
            signal_session(session, signal.SIGTERM)
            session.kill_at = time.monotonic() + 3


def main():
    inbox = bytearray()
    send(R_READY, 0, json.dumps({"kernel": os.uname().release, "agent": 2}).encode())
    while True:
        readers = [port, wake_r] + [s.fd for s in sessions.values() if not s.eof]
        writers = [s.wfd for s in sessions.values() if (s.outbox or s.connecting) and s.wfd is not None]
        try:
            readable, writable, _ = select.select(readers, writers, [], 1.0)
        except InterruptedError:
            continue
        if wake_r in readable:
            try:
                os.read(wake_r, 256)
            except OSError:
                pass
        if port in readable:
            inbox += os.read(port, 65536)
            while len(inbox) >= HEADER.size:
                kind, channel, length = HEADER.unpack_from(inbox)
                if len(inbox) < HEADER.size + length:
                    break
                payload = bytes(inbox[HEADER.size:HEADER.size + length])
                del inbox[:HEADER.size + length]
                handle(kind, channel, payload)
        for session in list(sessions.values()):
            if session.connecting:
                if session.fd not in writable:
                    continue
                session.connecting = False
                if session.sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR):
                    session.code = 1
                    finish(session)
                    continue
            if session.wfd in writable and session.outbox:
                try:
                    n = os.write(session.wfd, session.outbox[:65536 if session.wfd != session.fd else 1024])
                    del session.outbox[:n]
                except BlockingIOError:
                    pass
                except OSError:
                    session.outbox.clear()
            if session.close_input and not session.outbox and session.wfd not in (None, session.fd):
                os.close(session.wfd)
                session.wfd = None
                session.close_input = False
            if session.fd in readable and session.channel in sessions:
                try:
                    chunk = os.read(session.fd, 4096)
                except BlockingIOError:
                    chunk = None
                except OSError as exc:
                    # EIO: the terminal's last user went away. Exit is reported by reap().
                    chunk = None if exc.errno == errno.EIO else b""
                if chunk:
                    send(R_DATA, session.channel, chunk)
                elif chunk is not None and session.sock is not None:
                    session.code = 0  # peer closed the connection
                    finish(session)
                    continue
                elif chunk is not None:
                    session.eof = True  # output closed; wait for the process to exit
            if session.kill_at and time.monotonic() > session.kill_at:
                session.kill_at = None
                signal_session(session, signal.SIGKILL)
        reap()


main()

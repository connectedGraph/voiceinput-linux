"""Isolated terminal recipient: read the IM commit as raw PTY bytes, never as a shell command."""
import os
import pathlib
import sys
import termios
import tty

out = pathlib.Path(sys.argv[1])
expected_bytes = int(sys.argv[2])
old = termios.tcgetattr(0)
try:
    tty.setraw(0)
    out.with_suffix('.ready').write_text('ready')
    data = bytearray()
    while len(data) < expected_bytes:
        data.extend(os.read(0, expected_bytes - len(data)))
    out.write_bytes(data)
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, old)

#!/usr/bin/env python3
"""
Read live data from the Kestrel 5 flight controller over USB using MSP,
the same protocol Betaflight Configurator uses.

Safety: this only READS. Still, take the props off whenever a battery is
plugged in on the bench.

Setup:  pip install pyserial
Run:    python3 msp_monitor.py --port /dev/ttyACM0     (Linux)
        python3 msp_monitor.py --port /dev/cu.usbmodem0x80000001   (macOS)
        python3 msp_monitor.py --port COM5             (Windows)
        python3 msp_monitor.py --selftest              (no hardware needed)

MSP v1 frame:  '$' 'M' '<'  size  cmd  payload...  checksum
               checksum = XOR of size, cmd and every payload byte
The FC answers with the same layout but '>' instead of '<'.
"""
import argparse
import struct
import sys
import time

MSP_STATUS = 101     # cycle time, sensors, arming flags
MSP_RC = 105         # channel values, 1000-2000 us
MSP_RAW_GPS = 106    # fix, satellites, lat/lon
MSP_ATTITUDE = 108   # roll, pitch (0.1 deg), yaw (deg)
MSP_ANALOG = 110     # battery voltage, mAh used, rssi, current


def encode(cmd, payload=b''):
    size = len(payload)
    ck = size ^ cmd
    for b in payload:
        ck ^= b
    return b'$M<' + bytes([size, cmd]) + payload + bytes([ck])


def decode(buf):
    """Return (cmd, payload) from a complete response frame, or raise ValueError."""
    if len(buf) < 6 or buf[:3] not in (b'$M>', b'$M!'):
        raise ValueError('not an MSP response')
    size, cmd = buf[3], buf[4]
    payload = buf[5:5 + size]
    ck = size ^ cmd
    for b in payload:
        ck ^= b
    if len(payload) != size or buf[5 + size] != ck:
        raise ValueError('bad checksum or short frame')
    if buf[2:3] == b'!':
        raise ValueError(f'FC rejected command {cmd}')
    return cmd, payload


class FlightController:
    def __init__(self, port):
        import serial  # pip install pyserial
        self.s = serial.Serial(port, 115200, timeout=0.5)
        time.sleep(0.2)
        self.s.reset_input_buffer()

    def request(self, cmd):
        self.s.write(encode(cmd))
        # sync to the '$M' header, then read the rest of the frame
        while True:
            c = self.s.read(1)
            if not c:
                raise TimeoutError('no reply from flight controller (right port? Configurator closed?)')
            if c == b'$' and self.s.read(1) == b'M':
                break
        head = self.s.read(3)                     # direction, size, cmd
        body = self.s.read(head[1] + 1)           # payload + checksum
        return decode(b'$M' + head + body)[1]


def parse_attitude(p):
    roll, pitch, yaw = struct.unpack('<hhh', p[:6])
    return roll / 10, pitch / 10, yaw


def parse_analog(p):
    vbat, mah, rssi, amps = struct.unpack('<BHHh', p[:7])
    return vbat / 10, mah, rssi * 100 // 1023, amps / 100


def parse_rc(p):
    return list(struct.unpack('<' + 'H' * (len(p) // 2), p))


def parse_gps(p):
    fix, sats, lat, lon, alt, speed = struct.unpack('<BBiiHH', p[:14])
    return fix, sats, lat / 1e7, lon / 1e7, alt, speed / 100


def selftest():
    frame = encode(MSP_ATTITUDE)
    assert frame == b'$M<\x00\x6c\x6c', frame
    payload = struct.pack('<hhh', -125, 42, 271)
    ck = len(payload) ^ MSP_ATTITUDE
    for b in payload:
        ck ^= b
    reply = b'$M>' + bytes([len(payload), MSP_ATTITUDE]) + payload + bytes([ck])
    cmd, p = decode(reply)
    assert cmd == MSP_ATTITUDE and parse_attitude(p) == (-12.5, 4.2, 271)
    print('selftest ok: request', frame.hex(' '), '-> roll -12.5, pitch 4.2, yaw 271')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port')
    ap.add_argument('--hz', type=float, default=10)
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not a.port:
        ap.error('give --port, or --selftest')

    fc = FlightController(a.port)
    print('Tilt the quad by hand and watch roll/pitch change. Ctrl+C to stop.\n')
    while True:
        roll, pitch, yaw = parse_attitude(fc.request(MSP_ATTITUDE))
        volts, mah, rssi, amps = parse_analog(fc.request(MSP_ANALOG))
        rc = parse_rc(fc.request(MSP_RC))
        line = (f'roll {roll:6.1f}°  pitch {pitch:6.1f}°  yaw {yaw:4d}°  |  '
                f'{volts:4.1f} V ({volts / 6:4.2f} V/cell) {amps:5.1f} A {mah:4d} mAh  |  '
                f'thr {rc[3] if len(rc) > 3 else 0:4d}  arm {rc[4] if len(rc) > 4 else 0:4d}')
        sys.stdout.write('\r' + line)
        sys.stdout.flush()
        time.sleep(1 / a.hz)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print()

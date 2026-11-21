#!/usr/bin/env python3
"""
Fly an autonomous square mission in SIMULATION with ArduPilot SITL + pymavlink.

This is how you "program" a drone to fly itself: a ground computer (or a
companion computer on the drone) sends MAVLink commands to the autopilot.
Always prove a mission in simulation before it goes near real hardware.

Setup (Linux/macOS/WSL):
  1. Install ArduPilot SITL: https://ardupilot.org/dev/docs/building-setup-linux.html
  2. Start a simulated quad:   sim_vehicle.py -v ArduCopter --console --map
  3. pip install pymavlink
  4. python3 sitl_mission.py --connect udp:127.0.0.1:14550

The quad arms, climbs to 10 m, flies a 20 m square, returns and lands.
"""
import argparse
import math
import time

from pymavlink import mavutil


def wait_until(pred, timeout, what):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if pred():
            return
        time.sleep(0.2)
    raise TimeoutError(what)


class Drone:
    def __init__(self, url):
        self.m = mavutil.mavlink_connection(url)
        self.m.wait_heartbeat()
        print(f'connected to system {self.m.target_system}')
        # ask for position and status messages at 10 Hz
        self.m.mav.request_data_stream_send(self.m.target_system, self.m.target_component,
                                            mavutil.mavlink.MAV_DATA_STREAM_ALL, 10, 1)

    def pos(self):
        msg = self.m.recv_match(type='LOCAL_POSITION_NED', blocking=True, timeout=2)
        return (msg.x, msg.y, -msg.z) if msg else None   # north, east, up (m)

    def mode(self, name):
        self.m.set_mode(self.m.mode_mapping()[name])
        # pymavlink tracks the vehicle's current mode in .flightmode from its heartbeats
        wait_until(lambda: self.m.recv_match(type='HEARTBEAT', blocking=True, timeout=1) is not None
                   and self.m.flightmode == name, 10, f'mode {name}')
        print('mode', name)

    def arm(self):
        self.m.arducopter_arm()
        print('arming (waits for pre-arm checks: GPS lock, EKF ready) ...')
        self.m.motors_armed_wait()
        print('armed')

    def takeoff(self, alt):
        self.m.mav.command_long_send(self.m.target_system, self.m.target_component,
                                     mavutil.mavlink.MAV_CMD_NAV_TAKEOFF, 0, 0, 0, 0, 0, 0, 0, alt)
        wait_until(lambda: (p := self.pos()) and p[2] > alt * 0.95, 30, 'takeoff')
        print(f'at {alt} m')

    def goto(self, north, east, up):
        """Fly to a point in metres from the arming spot (local NED frame)."""
        mask = 0b0000111111111000  # use position only
        self.m.mav.set_position_target_local_ned_send(
            0, self.m.target_system, self.m.target_component,
            mavutil.mavlink.MAV_FRAME_LOCAL_NED, mask,
            north, east, -up, 0, 0, 0, 0, 0, 0, 0, 0)

        def arrived():
            p = self.pos()
            return p and math.dist(p, (north, east, up)) < 1.0
        wait_until(arrived, 60, f'reach {north},{east}')
        print(f'reached N{north:+.0f} E{east:+.0f}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--connect', default='udp:127.0.0.1:14550')
    ap.add_argument('--alt', type=float, default=10)
    ap.add_argument('--side', type=float, default=20)
    a = ap.parse_args()

    d = Drone(a.connect)
    d.mode('GUIDED')
    d.arm()
    d.takeoff(a.alt)
    for n, e in [(a.side, 0), (a.side, a.side), (0, a.side), (0, 0)]:
        d.goto(n, e, a.alt)
    d.mode('LAND')
    d.m.motors_disarmed_wait()
    print('landed and disarmed')


if __name__ == '__main__':
    main()

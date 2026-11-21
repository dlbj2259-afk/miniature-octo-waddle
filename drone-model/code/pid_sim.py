#!/usr/bin/env python3
"""
Kestrel 5 roll-axis simulator: see how P, I and D shape the response.

This is the same loop a flight controller runs thousands of times a second:
  gyro -> filter -> PID -> mixer -> motors -> physics -> gyro ...

It uses Betaflight's own gain scaling, so P/I/D numbers here behave like the
sliders in the Betaflight PID tab (defaults for roll: P 45, I 80, D 40).

Run:  python3 pid_sim.py                 (Betaflight-like defaults)
      python3 pid_sim.py --p 80 --d 10   (try a bad tune and watch it ring)
      python3 pid_sim.py --plot          (matplotlib chart, if installed)
"""
import argparse
import math
import random

# Betaflight scaling constants (src/main/flight/pid.h)
PTERM_SCALE = 0.032029
ITERM_SCALE = 0.244381
DTERM_SCALE = 0.000529
MIXER_SCALE = 1000.0

# Kestrel 5 physics (roll axis)
INERTIA = 0.0016      # kg*m^2, moment of inertia about the roll axis
MAX_TORQUE = 1.1      # N*m, full differential thrust (left vs right motors)
MOTOR_LAG = 0.020     # s, how long motors+props take to change speed
AIR_DAMPING = 0.0002  # N*m per deg/s, props and air resist fast rotation
CG_OFFSET_TORQUE = 0.03  # N*m, battery a few mm off-centre: a constant push the I-term must cancel
ITERM_RELAX_HZ = 15   # Betaflight iterm_relax_cutoff
ITERM_RELAX_DPS = 40  # setpoint change rate (deg/s, high-passed) where I stops accumulating
LOOP_HZ = 4000        # PID loop rate
GYRO_NOISE = 6.0      # deg/s of random noise on the gyro
DTERM_LPF_HZ = 100    # D-term low-pass filter


def lowpass(prev, new, cutoff_hz, dt):
    rc = 1.0 / (2 * math.pi * cutoff_hz)
    a = dt / (rc + dt)
    return prev + a * (new - prev)


def simulate(p, i, d, step_dps=400.0, seconds=0.4, noise=GYRO_NOISE, seed=1):
    random.seed(seed)
    dt = 1.0 / LOOP_HZ
    rate = 0.0          # true roll rate, deg/s
    torque = 0.0        # actual torque from motors, N*m
    iterm = 0.0
    prev_gyro = 0.0
    dterm_f = 0.0
    sp_lp = 0.0
    log = []
    for n in range(int(seconds * LOOP_HZ)):
        t = n * dt
        setpoint = step_dps if t >= 0.05 else 0.0     # stick snaps to a 400 deg/s roll

        # 1. read the gyro (true rate + noise)
        gyro = rate + random.gauss(0, noise)

        # 2. PID on the rate error, Betaflight style
        error = setpoint - gyro
        pterm = p * PTERM_SCALE * error
        # I-term relax: while the stick is moving fast, don't let I wind up (it would overshoot)
        sp_lp = lowpass(sp_lp, setpoint, ITERM_RELAX_HZ, dt)
        relax = max(0.0, 1.0 - abs(setpoint - sp_lp) / ITERM_RELAX_DPS)
        iterm += i * ITERM_SCALE * error * relax * dt
        iterm = max(-250.0, min(250.0, iterm))            # anti-windup
        raw_d = -(gyro - prev_gyro) / dt                   # D on measurement, not error
        prev_gyro = gyro
        dterm_f = lowpass(dterm_f, raw_d, DTERM_LPF_HZ, dt)
        dterm = d * DTERM_SCALE * dterm_f
        u = (pterm + iterm + dterm) / MIXER_SCALE          # -1 .. 1 of available authority
        u = max(-1.0, min(1.0, u))

        # 3. mixer -> motors: roll = speed up one side, slow the other.
        #    Motors can't change instantly, so torque lags the command.
        torque += (u * MAX_TORQUE - torque) * dt / MOTOR_LAG

        # 4. physics: torque = inertia * angular acceleration
        net = torque - AIR_DAMPING * rate + CG_OFFSET_TORQUE
        rate += math.degrees(net / INERTIA) * dt
        log.append((t, setpoint, rate, u))
    return log


def metrics(log, step):
    t0 = 0.05
    after = [(t, r) for t, s, r, u in log if t >= t0]
    peak = max(r for _, r in after)
    rise = next((t - t0 for t, r in after if r >= 0.9 * step), float('nan'))
    settle = t0
    for t, r in after:
        if abs(r - step) > 0.05 * step:
            settle = t
    tail = [r for t, r in after if t > after[-1][0] - 0.1]
    jitter = (sum((r - sum(tail) / len(tail)) ** 2 for r in tail) / len(tail)) ** 0.5
    return {
        'rise_ms': rise * 1000,
        'overshoot_pct': max(0.0, (peak - step) / step * 100),
        'settle_ms': (settle - t0) * 1000,
        'final_error_dps': step - sum(tail) / len(tail),
        'jitter_dps': jitter,
    }


def ascii_plot(log, step, width=72, height=18):
    lo, hi = -0.1 * step, 1.5 * step
    cols = [log[int(k * (len(log) - 1) / (width - 1))] for k in range(width)]
    rows = []
    for row in range(height, -1, -1):
        v = lo + (hi - lo) * row / height
        line = ''
        for _, s, r, _ in cols:
            cell_r = round((r - lo) / (hi - lo) * height)
            cell_s = round((s - lo) / (hi - lo) * height)
            line += '#' if cell_r == row else ('-' if cell_s == row else ' ')
        rows.append(f'{v:7.0f} |{line}')
    rows.append(' ' * 8 + '+' + '-' * width)
    rows.append(' ' * 9 + f'0 ms{" " * (width - 12)}{log[-1][0] * 1000:.0f} ms')
    return '\n'.join(rows)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--p', type=float, default=45)
    ap.add_argument('--i', type=float, default=80)
    ap.add_argument('--d', type=float, default=40)
    ap.add_argument('--step', type=float, default=400, help='roll rate command, deg/s')
    ap.add_argument('--plot', action='store_true', help='show a matplotlib chart')
    a = ap.parse_args()

    log = simulate(a.p, a.i, a.d, a.step)
    m = metrics(log, a.step)
    print(f'P {a.p:g}  I {a.i:g}  D {a.d:g}   step to {a.step:g} deg/s\n')
    print(ascii_plot(log, a.step))
    print('\n# = actual roll rate, - = what the pilot asked for\n')
    print(f"rise time     {m['rise_ms']:6.1f} ms   (time to reach 90%)")
    print(f"overshoot     {m['overshoot_pct']:6.1f} %    (keep under ~10%)")
    print(f"settling      {m['settle_ms']:6.1f} ms   (until within 5%)")
    print(f"steady error  {m['final_error_dps']:6.1f} deg/s  (I-term removes this)")
    print(f"jitter        {m['jitter_dps']:6.1f} deg/s  (wobble after settling; noise or a bad P:D balance)")

    if a.plot:
        import matplotlib.pyplot as plt
        t = [r[0] * 1000 for r in log]
        plt.plot(t, [r[1] for r in log], label='setpoint')
        plt.plot(t, [r[2] for r in log], label='roll rate')
        plt.xlabel('ms'); plt.ylabel('deg/s'); plt.legend(); plt.title(f'P{a.p:g} I{a.i:g} D{a.d:g}')
        plt.show()


if __name__ == '__main__':
    main()

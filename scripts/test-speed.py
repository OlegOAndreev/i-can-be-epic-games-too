#!/usr/bin/env python3

import math

# Linear dv = (t - v) * alpha * dt
# Exp dv = (t - v) * (1 - exp(-alpha*dt))

for linear in [True, False]:
    for N in [30, 60, 120]:
        vx = 0
        vy = 1
        wx = 1
        wy = 0
        dt = 1 / N
        if linear:
            alpha = 10.0
            print('linear', N)
            for i in range(N):
                dvx = (wx - vx) * alpha * dt
                dvy = (wy - vy) * alpha * dt
                vx += dvx
                vy += dvy
                if i + 1 in [N / 10, N / 3, N / 2]:
                    print(i * dt, vx, vy)
        else:
            alpha = 10.0
            print('exp', N)
            for i in range(N):
                dvx = (wx - vx) * (1 - math.exp(-alpha * dt))
                dvy = (wy - vy) * (1 - math.exp(-alpha * dt))
                vx += dvx
                vy += dvy
                if i + 1 in [N / 10, N / 3, N / 2]:
                    print((i + 1) * dt, vx, vy)

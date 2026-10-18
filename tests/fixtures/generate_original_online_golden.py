"""Regenerate parity data by executing the archived Python correction function.

Usage: python generate_original_online_golden.py /path/to/original_online.py
Only the named, dependency-free functions are compiled from that source. The
source SHA-256 is stored with the fixture; no JS implementation is consulted.
"""
import ast
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

source = Path(sys.argv[1])
source_bytes = source.read_bytes()
tree = ast.parse(source_bytes)
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)
             and node.name in {"correction_matrix", "_row_transform"}]
assert len(functions) == 2
namespace = {"np": np}
exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), "exec"), namespace)
correction_matrix = namespace["correction_matrix"]
row_transform = namespace["_row_transform"]
rng = np.random.default_rng(184903)
default_lambda = 1.2725674932370515e-5
cases = []
for name, n, total, window, scale, lam, rank_one in [
    ("scalar-one-pair", 1, 1, 60, .02, default_lambda, False),
    ("noncommuting-three", 3, 7, 60, .01, default_lambda, False),
    ("seven-rank-one", 7, 35, 60, .02, default_lambda, True),
    ("voltage-physical-units", 23, 80, 60, .001, default_lambda, False),
    ("seven-custom-window", 7, 45, 9, .3, .37, False),
    ("voltage-rank-one", 23, 1, 60, .001, default_lambda, True),
]:
    h = scale*rng.normal(size=(total, n))
    if rank_one:
        h = np.outer(h[:, 0], np.linspace(.2, 1.3, n))
    y = .7*h + scale*.4*rng.normal(size=(total, n))
    if total > window:
        # A nonstationary discarded prefix makes mistaken whole-history fits fail.
        y[:total-window] += 20*scale
    hh, yy = h[-window:], y[-window:]
    matrix = correction_matrix(yy, hh, lam, "online_sls")
    scalar = correction_matrix(yy, hh, lam, "scalar")[0, 0]
    def diagnostic(c):
        residual = hh@c.T-yy
        delta = c-np.eye(n)
        return {"rms": float(np.sqrt(np.mean(residual**2))),
                "delta": float(np.linalg.norm(delta)),
                "objective": float(.5*np.sum(residual**2)/len(hh)+.5*lam*np.sum(delta**2))}
    cases.append({"name": name, "dimension": n, "window": window, "lambda": lam,
                  "samples": [{"forecast": a.tolist(), "disturbance": b.tolist()}
                              for a, b in zip(h, y)],
                  "matrix": matrix.tolist(), "scalar": float(scalar),
                  "diagnostics": {"raw": diagnostic(np.eye(n)), "matrix": diagnostic(matrix),
                                  "scalar": diagnostic(scalar*np.eye(n))}})

case = cases[1]
C = np.array(case["matrix"])
c = case["scalar"]
K = rng.normal(size=(2, 3))*.2
x = rng.normal(size=3)
blocks = []
forecast = {}
expected = {"matrix": [], "scalar": []}
for q in [-1, 0, 4, 7, 8, 10, 12, 13]:
    X, U = rng.normal(size=(3, 3)), rng.normal(size=(2, 3))
    blocks.append({"k": q+1, "X": X.tolist(), "U": U.tolist(), "L": (U-K@X).tolist()})
    forecast[str(q)] = rng.normal(size=3).tolist()
    if 4 <= q < 13:
        for family, correction in [("matrix", C), ("scalar", c*np.eye(3))]:
            hx = row_transform(X, correction, "scalar" if family == "scalar" else "online_sls")
            hu = row_transform(U, correction, "scalar" if family == "scalar" else "online_sls")
            expected[family].append({"k": q+1, "X": hx.tolist(), "U": hu.tolist(), "L": (hu-K@hx).tolist()})
actions = {}
for family, row in expected.items():
    u = K@x
    for block in row:
        u += np.array(block["L"])@forecast[str(block["k"]-1)]
    actions[family] = u.tolist()

result = {"provenance": {"source": "src/online_sls/original_online.py",
                         "source_sha256": hashlib.sha256(source_bytes).hexdigest(),
                         "functions": ["correction_matrix", "_row_transform"],
                         "numpy_version": np.__version__, "seed": 184903,
                         "scope": "Ridge and current predictive response row; static-K realization only, not vendor K_e trajectories"},
          "cases": cases,
          "deployed": {"case": "noncommuting-three", "K": K.tolist(), "x": x.tolist(),
                       "time": 9, "historyWindow": 5, "predictionWindow": 4,
                       "blocks": blocks, "forecast": forecast, "expected": expected, "actions": actions}}
path = Path(__file__).with_name("original-online-golden.json")
path.write_text(json.dumps(result, indent=2)+"\n")
print(path)

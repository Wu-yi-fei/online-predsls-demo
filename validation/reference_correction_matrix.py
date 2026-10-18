"""Verbatim original correction_matrix; standalone numerical validation."""
import numpy as np

def correction_matrix(realized, forecast, regularization, family='online_sls'):
    """Minimize mean(||C h-y||²)/2 + lambda ||C-I||F²/2.

    Rows contain completed observation/prediction pairs. One-dimensional
    vectors are accepted as one pair, recovering the original closed form.
    Scalar's n*lambda follows from the same matrix Frobenius regularizer.
    """
    y, h = np.asarray(realized, dtype=float), np.asarray(forecast, dtype=float)
    if y.ndim == h.ndim == 1:
        y, h = y[None], h[None]
    if y.shape != h.shape or y.ndim != 2 or min(y.shape) < 1 or not np.isfinite(y).all() or not np.isfinite(h).all():
        raise ValueError('correction samples must have equal finite nonempty (W,n) shapes')
    if not np.isfinite(regularization) or regularization <= 0:
        raise ValueError('regularization must be finite and positive')
    W, n = h.shape
    lam = float(regularization)
    if family == 'scalar':
        return np.eye(n) * ((np.sum(y*h)/W + n*lam) / (np.sum(h*h)/W + n*lam))
    if family == 'online_sls':
        numer = y.T @ h/W + lam*np.eye(n)
        denom = h.T @ h/W + lam*np.eye(n)
        return np.linalg.solve(denom.T, numer.T).T
    raise ValueError('unknown correction family')

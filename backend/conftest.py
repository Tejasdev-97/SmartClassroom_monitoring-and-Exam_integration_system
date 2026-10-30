"""
Root conftest for the backend test suite.
Adds the backend package directory to sys.path so that 'app.*' imports work
regardless of the working directory pytest is invoked from.
"""
import sys
import os

# Ensure the backend/ directory (which contains the 'app' package) is importable.
_BACKEND_DIR = os.path.dirname(__file__)
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

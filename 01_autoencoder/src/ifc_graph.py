"""IFC element -> point-cloud graph, for the IFCNet graph autoencoder.

Pipeline (one IFC file holds one element):

    IFC file -> triangle mesh -> 1024 surface points -> normalised points
             -> k-nearest-neighbour edges -> PyTorch Geometric ``Data``

The model input is GEOMETRY ONLY: point coordinates and neighbour links.
The IFC class, name and properties are never read here, to avoid data leakage.

Everything up to ``ifc_to_arrays`` uses only NumPy, SciPy, trimesh and
IfcOpenShell, so a model server can reuse it without PyTorch. ``to_pyg_data``
and ``ifc_to_graph`` need torch and torch_geometric.

Used by: 01_autoencoder/notebook/ifcautoencoder.ipynb (dataset building)
and the model server (same preprocessing at inference time).
"""

from pathlib import Path

import numpy as np
import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.shape
import trimesh
from scipy.spatial import cKDTree

# Preprocessing defaults agreed by the team. Change them only together with P2,
# because the trained model depends on them.
N_POINTS = 1024     # points per element = nodes per graph
K_NEIGHBOURS = 16   # each point is linked to its 16 nearest points
SEED = 42           # fixed seed for the point sampling

# Triangle mesh in metres, in WORLD (building) coordinates, so that the z axis
# is the real "up" of the building: a wall stands, a slab lies flat.
_GEOM_SETTINGS = ifcopenshell.geom.settings()
_GEOM_SETTINGS.set("use-world-coords", True)


def ifc_to_mesh(path):
    """Read the single element of an IFC file and return its triangle mesh.

    Returns
    -------
    vertices : float64 array [V, 3], x y z in metres (world coordinates)
    faces    : int array [F, 3], indices of the 3 vertices of each triangle

    Raises ValueError if the file has no element with geometry, and
    RuntimeError (from IfcOpenShell) if the geometry cannot be built.
    """
    model = ifcopenshell.open(str(Path(path)))
    elements = [p for p in model.by_type("IfcProduct") if p.Representation is not None]
    if not elements:
        raise ValueError(f"no element with geometry in {path}")
    # IFCNetCore has exactly one element with geometry per file (checked in the notebook).
    shape = ifcopenshell.geom.create_shape(_GEOM_SETTINGS, elements[0])
    vertices = ifcopenshell.util.shape.get_vertices(shape.geometry)
    faces = ifcopenshell.util.shape.get_faces(shape.geometry)
    if len(vertices) == 0 or len(faces) == 0:
        raise ValueError(f"empty mesh in {path}")
    return vertices, faces


def sample_points(vertices, faces, n_points=N_POINTS, seed=SEED):
    """Sample ``n_points`` points spread over the mesh surface.

    Big triangles receive more points than small ones (area-weighted), so the
    points cover the surface evenly, whatever the number of mesh vertices
    (a wall has 8 vertices, a washbasin thousands).

    Returns a float32 array [n_points, 3].
    """
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    if not mesh.area > 0:
        raise ValueError("mesh has zero surface area")
    points, _ = trimesh.sample.sample_surface(mesh, n_points, seed=seed)
    return np.asarray(points, dtype=np.float32)


def normalize_points(points):
    """Centre the points at the origin and scale them into the unit sphere.

    After this step only the SHAPE remains: position and absolute size are
    removed, so a 10 m beam and a 1 m beam with the same proportions match.

    Returns (normalised points float32 [N, 3], scale in metres). The scale is
    the radius of the original object; it is kept only as information, it is
    NOT a model input.
    """
    centred = points - points.mean(axis=0)
    scale = float(np.linalg.norm(centred, axis=1).max())
    if not scale > 0:
        raise ValueError("all points are identical")
    return (centred / scale).astype(np.float32), scale


def knn_edges(points, k=K_NEIGHBOURS):
    """Link every point to its ``k`` nearest points (no link to itself).

    Returns ``edge_index``, an int64 array [2, N * k] in PyTorch Geometric
    format: row 0 = neighbour (source), row 1 = point (target). So every point
    receives exactly ``k`` incoming edges. The graph is directed: if A is among
    the 16 nearest points of B, B is not always among the 16 nearest of A.
    """
    n = len(points)
    # ask for k + 1 neighbours, because the closest one is usually the point itself
    _, idx = cKDTree(points).query(points, k=k + 1)
    centre = np.arange(n)[:, None]
    neighbours = np.empty((n, k), dtype=np.int64)
    for i in range(n):
        row = idx[i][idx[i] != i]   # drop the point itself
        neighbours[i] = row[:k]     # (if two points coincide, keep the k first)
    targets = np.repeat(centre, k, axis=1)
    return np.stack([neighbours.ravel(), targets.ravel()]).astype(np.int64)


def ifc_to_points(path, n_points=N_POINTS, seed=SEED):
    """IFC file -> normalised points float32 [n_points, 3] and scale in metres."""
    vertices, faces = ifc_to_mesh(path)
    points = sample_points(vertices, faces, n_points=n_points, seed=seed)
    return normalize_points(points)


def ifc_to_arrays(path, n_points=N_POINTS, k=K_NEIGHBOURS, seed=SEED):
    """Full NumPy pipeline for one IFC file (no PyTorch needed).

    Returns (points float32 [n_points, 3], edge_index int64 [2, n_points * k],
    scale in metres).
    """
    points, scale = ifc_to_points(path, n_points=n_points, seed=seed)
    return points, knn_edges(points, k=k), scale


# ----------------------------------------------------------------------------
# Crash-safe conversion
#
# For a few files IfcOpenShell's geometry engine (C++) crashes with a
# "segmentation fault". Such a crash cannot be caught with try/except: it kills
# the whole Python process (the notebook kernel, or the model server).
# So we convert files in a separate WORKER process. If the worker crashes or
# takes too long, only that file is marked as failed, a new worker is started,
# and the main process keeps running.
# ----------------------------------------------------------------------------

def _worker_loop(tasks, results, n_points, seed):
    """Runs inside the worker process: convert every path received on ``tasks``."""
    while True:
        path = tasks.get()
        if path is None:   # stop signal
            return
        try:
            points, scale = ifc_to_points(path, n_points=n_points, seed=seed)
            results.put(("ok", points, scale))
        except Exception as e:
            results.put(("error", f"{type(e).__name__}: {e}", None))


class SafeConverter:
    """Convert IFC files to points in a separate process that may crash safely.

    Use it as a context manager::

        with SafeConverter() as converter:
            status, points_or_message, scale = converter.convert("element.ifc")

    ``status`` is "ok" (then you get points and scale), or "error", "crash" or
    "timeout" (then you get a message and ``None``).
    """

    def __init__(self, timeout=120, n_points=N_POINTS, seed=SEED):
        import multiprocessing as mp
        self._ctx = mp.get_context("spawn")   # a fresh, independent Python process
        self.timeout = timeout
        self.n_points = n_points
        self.seed = seed
        self._process = None

    def _start(self):
        self._tasks = self._ctx.Queue()
        self._results = self._ctx.Queue()
        self._process = self._ctx.Process(
            target=_worker_loop, args=(self._tasks, self._results, self.n_points, self.seed), daemon=True)
        self._process.start()

    def _stop(self, force=False):
        if self._process is None:
            return
        if force or not self._process.is_alive():
            self._process.kill()
        else:
            self._tasks.put(None)
        self._process.join(timeout=10)
        self._process = None

    def convert(self, path):
        import queue
        import time

        if self._process is None or not self._process.is_alive():
            self._start()
        self._tasks.put(str(path))
        deadline = time.time() + self.timeout
        while True:
            try:
                return self._results.get(timeout=1)
            except queue.Empty:
                if not self._process.is_alive():
                    code = self._process.exitcode
                    self._stop(force=True)
                    return ("crash", f"worker process crashed (exit code {code})", None)
                if time.time() > deadline:
                    self._stop(force=True)
                    return ("timeout", f"no result after {self.timeout} s", None)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self._stop()


def to_pyg_data(points, edge_index, object_id=None, scale=None):
    """Wrap the arrays into a PyTorch Geometric ``Data`` graph.

    - ``x``   [N, 3] float32: node features = the normalised x y z of each point
              (this is what the graph network reads)
    - ``pos`` [N, 3] the same coordinates, under the name PyG uses for
              positions (needed by geometric transforms such as rotations)
    - ``edge_index`` [2, N * k] int64: the neighbour links
    - ``object_id`` and ``scale``: information only, never model inputs.
      The IFC class is deliberately NOT stored here; it lives in the split file.
    """
    import warnings
    import torch
    # torch_geometric uses torch.jit.script internally; torch >= 2.10 warns about it on import. Harmless.
    warnings.filterwarnings("ignore", message=r".*torch\.jit\.script.*", category=FutureWarning)
    from torch_geometric.data import Data

    pos = torch.from_numpy(points)
    data = Data(x=pos, pos=pos, edge_index=torch.from_numpy(edge_index))
    if object_id is not None:
        data.object_id = object_id
    if scale is not None:
        data.scale = torch.tensor([scale], dtype=torch.float32)
    return data


def ifc_to_graph(path, n_points=N_POINTS, k=K_NEIGHBOURS, seed=SEED):
    """IFC file -> PyTorch Geometric ``Data`` (the whole pipeline in one call)."""
    points, edge_index, scale = ifc_to_arrays(path, n_points=n_points, k=k, seed=seed)
    return to_pyg_data(points, edge_index, object_id=Path(path).stem, scale=scale)


# ----------------------------------------------------------------------------
# Dataset files
#
# To keep the files small (about 12 KB per object instead of 277 KB), a dataset
# file stores only the normalised POINTS. The kNN edges are rebuilt when the
# file is loaded, with the same ``knn_edges`` function the server uses, so the
# edges are identical everywhere. Rebuilding takes about 1.5 ms per graph.
#
# File content (a dict, saved with torch.save):
#   "points"        float32 tensor [N, n_points, 3]  normalised coordinates
#   "object_id"     list of N strings (IFC file names without .ifc)
#   "scale"         float32 tensor [N], object radius in metres (information only)
#   "preprocessing" dict with the settings used (n_points, k, seed, ...)
# The IFC class is NOT stored; it is in the split file (splits/ifc_split.csv).
# ----------------------------------------------------------------------------

def preprocessing_info():
    """The preprocessing settings, saved inside every dataset file."""
    return {
        "n_points": N_POINTS,
        "k_neighbours": K_NEIGHBOURS,
        "seed": SEED,
        "coordinates": "world (IfcOpenShell use-world-coords), metres",
        "sampling": "area-weighted uniform surface sampling (trimesh.sample.sample_surface)",
        "normalisation": "centre = mean of points, divide by max distance (unit sphere)",
        "edges": "directed kNN, row 0 = neighbour, row 1 = point, no self-loops",
        "ifcopenshell": ifcopenshell.version,
    }


def save_points_file(path, points, object_ids, scales):
    """Save a list of normalised point arrays as one dataset file (see format above)."""
    import torch

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({
        "points": torch.from_numpy(np.stack(points).astype(np.float32)),
        "object_id": list(object_ids),
        "scale": torch.tensor(scales, dtype=torch.float32),
        "preprocessing": preprocessing_info(),
    }, path)


def load_graphs(path):
    """Load a dataset file and return a list of PyTorch Geometric ``Data`` graphs.

    The kNN edges are rebuilt with the k stored in the file.
    """
    import torch

    content = torch.load(Path(path), weights_only=True)
    k = content["preprocessing"]["k_neighbours"]
    graphs = []
    for points, object_id, scale in zip(content["points"], content["object_id"], content["scale"]):
        edge_index = knn_edges(points.numpy(), k=k)
        graphs.append(to_pyg_data(points.numpy(), edge_index, object_id=object_id, scale=float(scale)))
    return graphs

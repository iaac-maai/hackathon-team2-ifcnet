"""Geometry-only GCN graph autoencoder for IFCNetCore graphs."""

import warnings

import torch
from torch import nn

# torch_geometric uses torch.jit.script internally; torch >= 2.10 warns about it on import. Harmless.
warnings.filterwarnings("ignore", message=r".*torch\.jit\.script.*", category=FutureWarning)
from torch_geometric.nn import GCNConv, global_mean_pool  # noqa: E402
from torch.utils.data import Dataset

from ifc_graph import knn_edges, to_pyg_data


class GraphAutoencoder(nn.Module):
    """Encode graph geometry and decode a fixed 1024-point reconstruction."""

    def __init__(self, latent_dim=32, hidden_dim=64, dropout=0.0, n_points=1024):
        super().__init__()
        self.n_points = n_points
        self.dropout = nn.Dropout(dropout)
        self.conv1 = GCNConv(3, hidden_dim)
        self.conv2 = GCNConv(hidden_dim, hidden_dim * 2)
        self.conv3 = GCNConv(hidden_dim * 2, hidden_dim * 2)
        self.to_latent = nn.Linear(hidden_dim * 2, latent_dim)
        self.decoder = nn.Sequential(
            nn.Linear(latent_dim, 256), nn.ReLU(),
            nn.Linear(256, 512), nn.ReLU(),
            nn.Linear(512, n_points * 3),
        )

    def encode(self, x, edge_index, batch):
        x = self.dropout(torch.relu(self.conv1(x, edge_index)))
        x = self.dropout(torch.relu(self.conv2(x, edge_index)))
        x = torch.relu(self.conv3(x, edge_index))
        return self.to_latent(global_mean_pool(x, batch))

    def decode(self, z):
        return self.decoder(z).reshape(z.shape[0], self.n_points, 3)

    def forward(self, data):
        z = self.encode(data.x, data.edge_index, data.batch)
        return self.decode(z), z


def chamfer_distance(pred, target):
    """Symmetric squared Chamfer distance for [B, N, 3] point clouds."""
    distances = torch.cdist(pred, target).square()
    return distances.min(dim=2).values.mean() + distances.min(dim=1).values.mean()


class LazyGraphDataset(Dataset):
    """Memory-light dataset: keep points, build one PyG graph per item."""

    def __init__(self, path, allowed_ids=None):
        content = torch.load(path, weights_only=True)
        self.points = content["points"]
        self.object_ids = list(content["object_id"])
        self.scales = content["scale"]
        self.k = content["preprocessing"]["k_neighbours"]
        allowed = set(allowed_ids) if allowed_ids is not None else None
        self.indices = [i for i, oid in enumerate(self.object_ids) if allowed is None or oid in allowed]

    def __len__(self):
        return len(self.indices)

    def __getitem__(self, index):
        if isinstance(index, slice):
            return [self[j] for j in range(*index.indices(len(self)))]
        i = self.indices[index]
        points = self.points[i].numpy()
        edge_index = knn_edges(points, k=self.k)
        return to_pyg_data(points, edge_index, object_id=self.object_ids[i], scale=float(self.scales[i]))


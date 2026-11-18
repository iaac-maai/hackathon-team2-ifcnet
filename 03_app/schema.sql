-- One row per prediction. Run with: npm run db:local   (or db:remote for the online database)
CREATE TABLE IF NOT EXISTS predictions (
  id          TEXT PRIMARY KEY,               -- a random id (crypto.randomUUID)
  created_at  TEXT NOT NULL,                  -- ISO date and time, UTC
  file_name   TEXT,                           -- the name of the uploaded .ifc file
  score       REAL NOT NULL,                  -- anomaly score (Chamfer distance) returned by the model server
  threshold   REAL NOT NULL,                  -- threshold used by the model server
  is_anomaly  INTEGER NOT NULL                -- 1 = unusual element, 0 = normal (SQLite has no boolean)
);

CREATE INDEX IF NOT EXISTS idx_predictions_created_at ON predictions (created_at);

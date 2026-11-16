-- Who uploaded which blob. A user may attach a blob to a message only when they uploaded it or it is already
-- attached in a chat they can read: knowing a sha256 is never enough to get the bytes (ARCHITECTURE 8).
CREATE TABLE blob_uploads (
  sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (sha256, user_id)
);

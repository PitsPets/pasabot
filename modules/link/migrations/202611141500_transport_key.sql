-- W28 tailcat: the linked machine's tunnel-level key (tailcat client node key, `nodekey:<hex>`), pinned during linking.
-- Only these keys are in our `tailcat serve --allow` list; unlink (revoked_at) drops the key from it at once.
-- NULL for transports without one (tcp-tls, memory) and for links made before this column existed.
ALTER TABLE link_peer ADD COLUMN transport_key TEXT;

-- One owner per server (ARCHITECTURE 3.1, 7): the owner role is the server's single administrator, so "owner-only"
-- routes need no per-resource ownership check. Extra users (W23) are members or guests, never a second owner.
CREATE UNIQUE INDEX users_single_owner ON users(kind) WHERE kind = 'owner';

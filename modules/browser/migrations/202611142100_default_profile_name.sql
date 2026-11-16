-- The first profile the server makes for the agents had an English name ("Agent browser") written by the server.
-- It is now unnamed ('') and the web shows its name in the owner's language; rename the old default the same way.
UPDATE browser_profile SET name = '' WHERE name = 'Agent browser';

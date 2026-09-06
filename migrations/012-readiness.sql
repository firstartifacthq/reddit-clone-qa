CREATE TABLE operational_capability (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  pulse INTEGER NOT NULL CHECK (typeof(pulse) = 'integer' AND pulse IN (0, 1))
);
INSERT INTO operational_capability (id, pulse) VALUES (1, 0);
CREATE TRIGGER operational_capability_cannot_delete BEFORE DELETE ON operational_capability
BEGIN SELECT RAISE(ABORT, 'operational singleton cannot be deleted'); END;
CREATE TRIGGER operational_capability_identity BEFORE UPDATE OF id ON operational_capability
BEGIN SELECT RAISE(ABORT, 'operational identity is immutable'); END;

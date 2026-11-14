ALTER TABLE projects ADD COLUMN preview_inherit_env_vars INTEGER NOT NULL DEFAULT 0 CHECK (preview_inherit_env_vars IN (0, 1));
ALTER TABLE projects ADD COLUMN preview_env_vars TEXT NOT NULL DEFAULT '[]';

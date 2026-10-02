# Plans and specs

This folder holds the plans and specs that code, migrations, skills or other
documents refer to by path, and those of work that is still in progress.
Everything else is a finished work record and lives in the maintainers'
archive.

A spec stays here while one of these is true:

- a file outside this folder refers to it by path
  (`git grep -lF docs/superpowers/<file> -- . ':!docs/superpowers'`);
- its work has an open branch or pull request;
- it is the only description of behaviour that ships.

New plans and specs follow the rule in AGENTS.md: no customers, no farms, no
individual gateways, no real EUIs or addresses.

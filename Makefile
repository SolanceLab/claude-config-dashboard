# `make test` runs every test in this room, whatever the language.
.PHONY: test
test:
	node --test test/*.test.mjs

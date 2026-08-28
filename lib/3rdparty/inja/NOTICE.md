# Vendored: Inja (fork)

`inja.hpp` is the amalgamated single-header build from the `improved` branch of
[navrocky/inja](https://github.com/navrocky/inja) (a fork of
[pantor/inja](https://github.com/pantor/inja) `v3.5.0`), copied from that repo's
`single_include/inja/inja.hpp`. The fork adds `{% filter %}...{% endfilter %}`
blocks, `indent`/`center` built-in functions, and macros (`{% macro %}`/`{% endmacro %}`) on top of
upstream 3.5.0; see `docs/templating.md` for the syntax.

It does not bundle `nlohmann/json.hpp` - that stays a normal Conan dependency
(`nlohmann_json/3.11.3` in `conanfile.txt`), same as before.

To update: rebuild `single_include/inja/inja.hpp` in the fork repo (its own README/scripts cover
that) and copy it over this file.

Licensed under the MIT License - see `LICENSE` in this directory (upstream copyright, unchanged by
the fork).

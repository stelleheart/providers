# nish's providers

package that holds pstream-compatible providers.
feel free to use for your own projects.

features:

- scrape popular streaming websites
- works in both browser and server-side

in addition to those included in p-stream's providers, i added support for 1anime and animepahe

additionally, there are some structural changes:
- this project prefers bun to pnpm (but is pm-agnostic)
- this project uses tsdown instead of vite
- the `lib/` folder is built with a pre-commit hook and included

these changes make the project more portable and make development much faster.

## using this

just import the package. you will automatically be using the files in the `lib/` folder! 🏵

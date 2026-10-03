# Optional fonts

`lib/render.js` scans this directory **first**, before system fonts.

Drop `.ttf` or `.otf` files here to pin the poster's typography so it renders
identically regardless of what is installed on the machine. The poster asks for
`Segoe UI, Inter, Helvetica, Arial, sans-serif` for text and
`Consolas, SF Mono, Menlo, monospace` for the footer.

[Inter](https://fonts.google.com/specimen/Inter) (OFL) is a good drop-in: add
`Inter-Regular.ttf`, `Inter-SemiBold.ttf` and `Inter-Bold.ttf`.

Empty is fine — system fonts are used, and on Windows Segoe UI is already there.

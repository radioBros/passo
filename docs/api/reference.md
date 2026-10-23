---
outline: [2, 3]
---

# API reference

The complete contract, **generated from the Zod schemas** that perform
validation at runtime — so the reference and the code cannot disagree. CI fails
if a schema changes without regenerating it.

Machine-readable: [`/openapi.json`](/openapi.json).

```bash
npx @openapitools/openapi-generator-cli generate \
  -i https://your-passo-host/openapi.json -g typescript-fetch -o ./passo-client
```

## Three rules the schema cannot express

These are semantic, not structural, and cause most integration failures:

1. **NS is terminal.** The invoice is legally *not issued*. `/retry` refuses it
   with a `409` — auto-retrying sends a duplicate to the tax authority.
2. **MC is not a failure.** The invoice **is** issued; SdI is still delivering.
3. **Money is a string.** `"1000.00"`, never `1000`. A bare integer is
   schema-invalid.

See [Errors](/api/errors) and [Notifications & webhooks](/api/webhooks).

## Endpoints

<!--@include: ./_endpoints.md-->

## Interactive explorer

<div id="openapi-ui" style="min-height:50vh"></div>

<ClientOnly>
<script setup>
import { onMounted } from 'vue'
onMounted(() => {
  // A convenience only — every endpoint is already listed above as static
  // markdown, so this page is complete even where the CDN is unreachable.
  const css = document.createElement('link')
  css.rel = 'stylesheet'
  css.href = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css'
  document.head.appendChild(css)
  const s = document.createElement('script')
  s.src = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js'
  s.onload = () => window.SwaggerUIBundle({
    url: '/openapi.json',
    domNode: document.getElementById('openapi-ui'),
    deepLinking: true,
  })
  s.onerror = () => {
    document.getElementById('openapi-ui').innerHTML =
      '<p><em>The interactive explorer could not load. Every endpoint is listed above.</em></p>'
  }
  document.body.appendChild(s)
})
</script>
</ClientOnly>

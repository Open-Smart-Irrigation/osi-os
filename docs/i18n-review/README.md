# AgroLink GUI translation — review pack

The AgroLink GUI is fully translated into all six non-English locales
(`de-CH`, `fr`, `it`, `es`, `pt`, `lg`). This pack is for native/domain review.

## What's here

- **`terms-<locale>.csv`** — every translated string for one locale, one file per
  language (1,140 strings each). Columns: `namespace, key, english, <locale>,
  shared_with_english`. Give each reviewer the CSV for their language; they can add a
  correction column and return it. `shared_with_english = yes` marks strings deliberately
  left identical to English (proper nouns like *OSI Server* / *AgroLink*, units like *kPa* /
  *pF*, acronyms like *RSSI* / *CPU*, and international loanwords) — those are intentional,
  not gaps.
- **`priority-terms.md`** — the subset the machine translators flagged as coined or
  uncertain, with no prior in-repo precedent. This is where review effort pays off most; the
  bulk of the CSV is routine UI copy.

## How the translations were produced

One translator pass per locale, told to reuse the terminology already shipped in that
locale's own files (not a single imposed glossary), preserve every `{{placeholder}}`, keep
protocol tokens exact (`FPort 100`, `LoRaWAN`, `kPa`), and flag anything uncertain rather than
guess silently. Swiss German uses `ss` never `ß`; Spanish uses *tú*; Portuguese is European
(pt-PT). Catalog labels (agronomic vocabulary such as crop and product names) are a **separate
data set that stays English for now** and are **not** in this pack.

## Highest stakes

`lg` (Luganda) serves a **live production gateway in Uganda**, and several of its terms are new
coinages with no prior corpus to check against — see `priority-terms.md`. The device-settings
strings (`kiwiSensor.*`, `stregaValve.*`) control real LoRaWAN hardware, so their technical
accuracy matters in every language.

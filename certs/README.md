# GigaChat application trust

Public Russian Trusted Root CA, downloaded2026-11-15 with ordinary HTTPS verification from https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt, linked by the provider documentation https://developers.sber.ru/docs/ru/gigachat/certificates . This file contains no private key or account credential.

DER SHA256: D26D2D0231B7C39F92CC738512BA54103519E4405D68B5BD703E9788CA8ECF31. Valid2022-03-01 through2032-02-27. scripts/check-gigachat-ca.mjs verifies the fingerprint, CA flag, signature and validity. Renewal requires review; the build never silently downloads new trust material.

The live Compose enables NODE_EXTRA_CA_CERTS only for the AI coordinator at /app/certs/gigachat-root-ca.pem. It does not modify the host trust store or disable validation. For local provider processes, set NODE_EXTRA_CA_CERTS in the parent environment **before** starting Node; setting it later through dotenv does not initialize Node's extra roots. Do not use NODE_TLS_REJECT_UNAUTHORIZED=0.

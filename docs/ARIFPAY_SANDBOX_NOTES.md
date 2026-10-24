# ArifPay direct-pay contract

Recorded 24 Oct 2026 from the public docs at developer.arifpay.net (create checkout session, Telebirr USSD, CBE, webhook shape, verify by session id, API errors, recommended merchant pattern). No `ARIFPAY_API_KEY` is configured in this repo, so none of these payloads have been replayed against the live sandbox. Fields marked unverified below must be checked on the first sandbox call before production.

Parents never see ArifPay. Telebirr and CBE Birr are USSD prompts on the parent's phone. Neither rail asks this platform for an OTP or a bank password. OTP belongs to other rails (Ahadu, Binget, Zamzam) and is out of scope.

## Hosts and auth

- Sandbox base URL used by ArifPay's Postman collection: `https://gateway.arifpay.org`. Do not point that collection at a production host.
- Production base URL is not stated on the pages above. `ARIFPAY_BASE_URL` must be set explicitly. Sandbox is allowed only when `ARIFPAY_SANDBOX=true` and `NODE_ENV` is not production.
- Every API call sends header `x-arifpay-key`. Missing or unknown keys return HTTP 404 `API Key Not found`, HTTP 401 `Bad credentials`, or HTTP 401 `Not approved for production`.
- API responses use `{ "error": boolean, "msg": string, "data": ... }`. HTTP 200 does not mean success. `error: true` with msg `The Checkout is Already Successful` or `The Checkout is Already Failed` is a terminal session. Matching is case-insensitive and ignores a trailing period. The Telebirr page spells the success msg `The Checkout is already Successful.`

## Phone and money

- Direct rails require `2519XXXXXXXX` or `2517XXXXXXXX`. `+251` and `09` are rejected by ArifPay. This app stores E.164 and converts with `toInternationalDigits` at the adapter boundary.
- Item `price` and `totalAmount` are JSON numbers in ETB (examples use `100` and `100.0`), not santim and not decimal strings. Convert with `santimToEtbString` and then to a number only inside the adapter. Read amounts back with `etbStringToSantim`.
- A session whose item total exceeds the merchant maximum returns HTTP 400, msg `Item total price, which is {amount}, cannot be greater than {max}`, data `"03"`.

## Calls this app makes

White-label uses the single-request direct rails so the parent is never sent to `paymentUrl`.

| Parent choice | Method | Body |
| --- | --- | --- |
| Telebirr | `POST /api/checkout/telebirr-ussd/transfer/direct` | Checkout session fields plus `phone` |
| CBE Birr | `POST /api/checkout/v2/cbe/direct/transfer` | Same checkout session body. Doc says this one call raises the USSD prompt. |

Accepted pending responses (HTTP 200, `error: false`):

- Telebirr `msg` is a provider description. Fixture uses `Success`. `data.sessionId` example `ED54BDB4D5BF2D` (short hex, not a UUID). `data.transaction.transactionStatus` is `PENDING`. `otp` and `url` are null.
- CBE `msg` is exactly `USSD request sent to your phone`, same `data` shape.

Checkout session fields we send: `nonce` (our `Payment.txRef`), `items`, `successUrl`, `errorUrl`, `cancelUrl`, `notifyUrl`, `phone`, `email` (school fallback when the parent gave none), `expireDate`, `lang: "EN"`, `currency: "ETB"`.

Beneficiaries are a doc conflict. The create-session page says to omit `paymentMethods` and `beneficiaries` so the gateway fills them from the platform merchant account. Older examples require `beneficiaries[].accountNumber`, `bank` (SWIFT, example `AWINETAA`), and `amount` equal to the item total. This app sends beneficiaries when the school has a payout account, because one platform merchant account would pool every school's fees. Unverified: whether the direct rails accept that array. If the first sandbox call returns a validation error on `beneficiaries`, stop sending them and keep attributing the payment to the school in our ledger.

## Nonce and session lookup

- `nonce` is unique per attempt. HTTP 400 `session already exist` means that nonce was already used. The error body does not include the session id.
- Recover with `GET /api/checkout/getSessionByNonce/{nonce}` (documented on the recommended-merchant page). Response body shape is unverified; assume the checkout-session object (`sessionId` / `uuid`, `nonce`, `totalAmount`, `transactionStatus`) until a sandbox call confirms it.
- `GET /api/checkout/session/{sessionId}` fetches a session. HTTP 404 `No Session found`. HTTP 400 `Session Expired`.
- `POST /api/checkout/session/cancel/{sessionId}` voids an unpaid session.

## Verify (the only source of PAID)

`GET /api/verify/transaction?uuid={sessionId}` with `x-arifpay-key`.

- Success body is a raw JSON array, not the `{ error, msg, data }` envelope.
- Unknown session id returns HTTP 200 and `[]`.
- Each element: `paymentType`, `amount` (number, ETB), `transactionId` (receipt), `status`, `nonce`, `session`.
- Status values seen in docs: `SUCCESS`, `PENDING`, `FAILED`, `CANCELED`, `EXPIRED`. The lifecycle page also writes `CANCELLED`. Accept both spellings.
- Do not mark an invoice paid from the notify body. Notify has no documented signature and is not retried by ArifPay.

Alternate lookup, unused by the happy path: `POST /api/checkout/getSessionByTransactionId` with `{ transactionId, paymentType }`.

## Notify body

`POST` raw JSON to `notifyUrl`. No signature header is documented. No automatic redelivery. Relevant fields:

`uuid`, `sessionId` (same value in the example), `nonce`, `phone`, `paymentMethod` (`TELEBIRR_USSD` or the CBE method code), `totalAmount`, `transactionStatus`, `transaction.transactionId`, `transaction.transactionStatus`.

`paymentMethod` for CBE on the direct rail is unverified. Treat `CBE` and `CBEBIRR` as CBE Birr until a sandbox notify shows the real value.

The receiver returns 200 quickly, stores the body on `WebhookEvent`, and settles only after verify.

## Errors the adapter must classify

| HTTP | msg | Meaning | Retryable |
| --- | --- | --- | --- |
| 400 | session already exist | Fetch the existing session by nonce | no |
| 400 | Session Expired | Attempt is expired | no |
| 404 | No Session found | Attempt is unknown at ArifPay | no |
| 200 | The Checkout is Already Successful | Verify and settle; do not create another attempt | no |
| 200 | The Checkout is Already Failed | Parent may start a new attempt | no |
| 400 | Validation Error | Fix the request; `data` is `{ field: message }` | no |
| 401 | Bad credentials / Not approved for production | Configuration | no |
| 404 | API Key Not found | Configuration | no |
| 500 | internal system error | Try again | yes |
| 429 | (not documented) | Treat as retryable if it appears | yes |

Non-JSON and transport failures are retryable. Error messages returned to parents and written to logs must not contain the API key or the full phone number.

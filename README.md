# Subtle Pay — Platform

The payments platform behind Subtle. Accounts, wallets, rates, settlement, merchant verification, and the operator console.

Subtle is a consumer payments product on Monad testnet. A user holds a private account and a custodial wallet. They pay by name or merchant QR in a familiar currency. The platform converts the amount and settles in MON.

This repository is the API. The consumer application is a separate repository and does not expose platform controls.

---

## Surfaces

| Surface | Audience | Address |
|---|---|---|
| API | User app and operators | `http://127.0.0.1:4000` |
| Consumer app | Users | `http://localhost:5173` |
| Operator console | Operators only | `http://localhost:5174` |

The operator console is a separate process. It is not linked from the consumer app. Admin routes reject requests that do not come from the local operator network.

---

## What is real

A Monad testnet payment was confirmed.

- Sender: `0xF384831F4233421660B8d35a590A20395366B3fe`
- Receiver: `0x8af044aC82Fa66C8Dbd2b02cF5C029D13C25598f`
- Transaction: [`0x2e1b73b0472134d4f573a434ba341305ae9721a72a44bba648b98971d8b91156`](https://testnet.monadvision.com/tx/0x2e1b73b0472134d4f573a434ba341305ae9721a72a44bba648b98971d8b91156)
- Chain id: `10143`

Also live: registration, sessions, aliases, contacts, live fiat and crypto rates, payment history, merchant bills, verified-merchant autopay, MPIN and biometric authorization, and the operator console.

`POST /bridge/preview` is a preview only. It returns `mode: "simulated"` and does not settle.

---

## Start the platform

Requirements: Node 22. Do not commit `.env`, `node_modules`, or `data/`.

```bash
git clone https://github.com/XPO09-DEV/Subtle-Pay-backend.git
cd Subtle-Pay-backend
cp .env.example .env
```

Fill `.env` with the secrets and Monad settings. At minimum:

```bash
JWT_ACCESS_SECRET=   # 64 hex characters
PASSWORD_PEPPER=     # 64 hex characters
MASTER_KEY=          # 64 hex characters
MONAD_RPC_URL=https://testnet-rpc.monad.xyz
MONAD_CHAIN_ID=10143
RELAYER_PRIVATE_KEY= # 0x + 64 hex
```

Optional, for operator approval of merchants from the command line:

```bash
MERCHANT_VERIFY_KEY=choose-a-secret
```

Then:

```bash
npm install
npm run dev
```

The API listens on `http://127.0.0.1:4000`.

```bash
curl http://127.0.0.1:4000/health
```

Expected: `{"ok":true}`.

On first start the platform creates the operator account if it is not already present.

---

## Start the consumer app

In a second terminal, from the frontend repository:

```bash
git clone https://github.com/XPO09-DEV/subtle-pay-frontend.git
cd subtle-pay-frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

A user registers, receives an account id, sets a name and an MPIN, funds the wallet from the [Monad faucet](https://faucet.monad.xyz), and sends.

---

## Operator console

The console is internal. It is not part of the consumer app and is not linked from it.

From the frontend repository, in a third terminal:

```bash
npm run dev:admin
```

Open [http://localhost:5174](http://localhost:5174).

Sign in with the operator name and password issued to the platform team. The account is created automatically when the API starts.

From the console an operator can:

1. See live counts of users, bans, merchant applications, autopay mandates, and payments.
2. Search a user by account id, name, or wallet address.
3. Ban an account with a required reason. All of that account’s sessions are revoked. Login and every authenticated call are rejected until the ban is lifted.
4. Unban after review.
5. Approve or reject a business verification. Only a verified business can receive autopay.
6. Inspect autopay mandates and revoke one. Revoking does not create a new customer mandate. Customer consent remains a customer action.
7. Read the append-only audit log.
8. Inspect allowed tables. Password hashes, MPINs, and private keys are redacted.
9. Check API and database health.

Admin routes accept traffic only from the local operator network.

---

## How a payment works

1. The user registers. The API returns an account id, a session, and a Monad address. The private key stays encrypted on the server.
2. The user funds that address.
3. The user pays by alias, contact, account id, or address, in INR, USD, or another supported currency.
4. The user confirms with their MPIN or biometric.
5. The platform freezes the rate, converts to MON, signs, and broadcasts.
6. A merchant bill is the same settlement, opened by QR and closed when the bill status is `paid`.

The handle is `alias@monad`, or the account id if no alias is set.

---

## Merchant verification and autopay

Autopay is only for merchant payments, and only for businesses Subtle has verified.

1. The business requests verification in Settings (name and contact).
2. An operator approves in the console, or with:

```bash
curl -X POST http://127.0.0.1:4000/admin/verify-merchant \
  -H "Content-Type: application/json" \
  -H "x-verify-key: $MERCHANT_VERIFY_KEY" \
  -d '{"accountId":"ACCOUNT_ID","approve":true}'
```

3. A customer may then set an autopay cap against that merchant. The platform rejects the request if the merchant is not verified.

Merchant eligibility does not create a payment mandate. The customer creates the mandate.

---

## Rates

Fiat rates are Frankfurter (ECB). Crypto prices are CoinGecko. Cache is 30 seconds, with a stale fallback if an upstream is down.

| Endpoint | Purpose |
|---|---|
| `GET /rates/all` | Full snapshot for dashboards |
| `GET /rates?currency=INR` | MON price and local rate |
| `GET /rates/quote?from=EUR&to=INR&amount=10` | Conversion |
| `GET /rates/token?currency=INR` | MON in that currency |

---

## Principal routes

| Route | Purpose |
|---|---|
| `POST /auth/register` | Account, wallet, session |
| `POST /auth/login` | Session from account id and password |
| `POST /auth/set-mpin` | User sets a payment MPIN |
| `POST /auth/biometric/register/verify` | User registers face or fingerprint |
| `GET /home` | Account, alias, address, balances, rate |
| `POST /payments/send` | Pay. Requires MPIN or biometric. |
| `POST /bills` | Merchant creates a bill |
| `POST /bills/:id/pay` | Customer pays a bill |
| `POST /merchant/verify-request` | Business asks to be verified |
| `POST /mandates` | Customer sets autopay for a verified merchant |
| `GET /health` | Process health |

Operator routes live under `/admin` and are documented in the console section above.

---

## Demo path for review

1. Start the API, the consumer app, and the operator console.
2. Register two users. Fund the sender.
3. Set an MPIN on the sender. Send to the receiver by name. Confirm with the MPIN.
4. As a business, request verification in Settings.
5. In the operator console, approve that business.
6. As a customer, set autopay against that business. Confirm it appears under Autopay.
7. Open a payment hash on MonadVision.

---

## Repositories

API: [github.com/XPO09-DEV/Subtle-Pay-backend](https://github.com/XPO09-DEV/Subtle-Pay-backend)  
Consumer app: [github.com/XPO09-DEV/subtle-pay-frontend](https://github.com/XPO09-DEV/subtle-pay-frontend)

Hackathon: Monad Metropolis.

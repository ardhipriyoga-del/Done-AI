---
name: Procedure estimates
description: Durable data and pricing rules for Estimasi Biaya Tindakan.
---

Estimasi Biaya Tindakan uses its own IndexedDB stores and must not replace or reinterpret the older inpatient billing estimate data. Patient and episode details are selected from the existing patient store. Its procedure action, tariff, category, and component mapping masters are imported and maintained separately from the older inpatient Billing Master Tarif.

**Why:** The older estimate panel has a different workflow and calculation model; sharing its records or tariff parser would risk changing existing inpatient billing behavior. The procedure workflow now follows the uploaded Excel action/tariff sources and Superuser-managed category mapping rather than hardcoded templates.

**How to apply:** Select actions from the imported action master, derive the action group automatically, resolve all component prices from the procedure tariff master by the patient's normalized class, and show unmapped components as warnings/subtotals instead of silently inventing categories or prices. Preserve Cloud/JSON and Excel backup coverage for the dedicated stores.
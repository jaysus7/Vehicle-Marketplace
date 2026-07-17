-- Desk C: provincial tax + lease/reserve modeling.
--   tax_province      — Canadian province, drives the auto-filled combined tax rate
--   buy_rate          — lender buy rate; the desk shows F&I reserve = sell-rate vs buy-rate
--   residual_amount   — lease residual ($) for the lease payment calculation
--   mileage_allowance — lease km/yr allowance (informational, prints on the lease worksheet)
alter table deals add column if not exists tax_province      text;
alter table deals add column if not exists buy_rate          numeric;
alter table deals add column if not exists residual_amount   numeric;
alter table deals add column if not exists mileage_allowance numeric;

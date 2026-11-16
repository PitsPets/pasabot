-- W32 wiring: a receipt records the budget's cost for its run with the currency it is in (one currency per server).
ALTER TABLE safety_receipts ADD COLUMN cost_currency TEXT;

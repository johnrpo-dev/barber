ALTER TABLE "sale_lines" DROP CONSTRAINT "sale_lines_kind_check";--> statement-breakpoint
ALTER TABLE "sale_lines" DROP CONSTRAINT "sale_lines_amounts_check";--> statement-breakpoint
ALTER TABLE "sale_lines" DROP CONSTRAINT "sale_lines_commission_check";--> statement-breakpoint
ALTER TABLE "sale_lines" ALTER COLUMN "service_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "product_id" bigint;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "quantity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_product_fk" FOREIGN KEY ("location_id","product_id") REFERENCES "public"."products"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sale_lines_product_idx" ON "sale_lines" USING btree ("location_id","product_id") WHERE "sale_lines"."product_id" is not null;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_item_check" CHECK (("sale_lines"."kind" = 'service' and "sale_lines"."service_id" is not null and "sale_lines"."product_id" is null and "sale_lines"."quantity" = 1)
        or ("sale_lines"."kind" = 'product' and "sale_lines"."product_id" is not null and "sale_lines"."service_id" is null and "sale_lines"."quantity" between 1 and 99));--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_kind_check" CHECK ("sale_lines"."kind" in ('service', 'product'));--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_amounts_check" CHECK ("sale_lines"."unit_price" >= 0 and "sale_lines"."discount" >= 0 and "sale_lines"."discount" <= "sale_lines"."unit_price" * "sale_lines"."quantity"
        and "sale_lines"."net" = "sale_lines"."unit_price" * "sale_lines"."quantity" - "sale_lines"."discount"
        and "sale_lines"."commission" >= 0 and "sale_lines"."commission_bps" between 0 and 10000);--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_commission_check" CHECK ("sale_lines"."commission" <= "sale_lines"."unit_price" * "sale_lines"."quantity");--> statement-breakpoint

-- ─── A mano ───────────────────────────────────────────────────────────────────
-- Sprint 6, fase C: vender productos en el cobro (docs/sprint-6-productos-inventario.md).
--   * Arriba (drizzle): sale_lines admite kind = 'product' con product_id y quantity (1 a 99); un
--     servicio sigue siendo de a uno. Las filas que ya existen son de servicio con cantidad 1 y
--     cumplen los CHECK nuevos sin cambios. unit_price es el precio de UNA unidad; el bruto de la
--     línea es unit_price × quantity. Sin columna de costo: el costo llega con el conteo (6135).
--   * sales_assert_totals cambia lo mínimo (copia de 0010, con el search_path de 0011):
--       - subtotal = suma de unit_price × quantity (antes, suma de unit_price: lo mismo con cantidad 1);
--       - 4170 = neto de las líneas de servicio, 4135 = neto de las líneas de producto;
--       - nuevo: el asiento de una venta solo toca sus cuentas (1105, 1110, 5305, 4170, 4135, 2380,
--         5105, 2335). Antes nada impedía una línea de más en otra cuenta mientras las de la lista
--         cuadraran. 1435 y 6135 ya los cerraba 0032.
--   No cambian: la anulación (reversa exacta del asiento), las liquidaciones (por línea y persona),
--   los permisos de villa_app (sale_lines sigue sin UPDATE salvo la supresión de 0016).
CREATE OR REPLACE FUNCTION sales_assert_totals(p_sale_id bigint) RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s sales%ROWTYPE;
  v_lines bigint; v_subtotal numeric; v_discount numeric; v_net numeric; v_commission numeric;
  v_service_net numeric; v_product_net numeric;
  v_tips numeric; v_payable numeric;
  v_paid numeric; v_cash numeric; v_electronic numeric; v_fees numeric;
  v_kind text;
BEGIN
  SELECT * INTO s FROM sales WHERE id = p_sale_id;
  SELECT count(*), coalesce(sum(unit_price * quantity), 0), coalesce(sum(discount), 0), coalesce(sum(net), 0),
         coalesce(sum(commission), 0),
         coalesce(sum(net) FILTER (WHERE kind = 'service'), 0), coalesce(sum(net) FILTER (WHERE kind = 'product'), 0)
    INTO v_lines, v_subtotal, v_discount, v_net, v_commission, v_service_net, v_product_net
    FROM sale_lines WHERE sale_id = p_sale_id;
  SELECT coalesce(sum(amount), 0), coalesce(sum(payable), 0) INTO v_tips, v_payable FROM sale_tips WHERE sale_id = p_sale_id;
  SELECT coalesce(sum(amount), 0), coalesce(sum(amount) FILTER (WHERE kind = 'cash'), 0),
         coalesce(sum(amount) FILTER (WHERE kind <> 'cash'), 0), coalesce(sum(fee), 0)
    INTO v_paid, v_cash, v_electronic, v_fees FROM sale_payments WHERE sale_id = p_sale_id;

  IF v_lines = 0 THEN
    RAISE EXCEPTION 'cobro: la venta % no tiene líneas', p_sale_id USING ERRCODE = 'check_violation';
  END IF;
  IF v_subtotal <> s.subtotal OR v_discount <> s.discount OR v_tips <> s.tips OR v_paid <> s.total_paid THEN
    RAISE EXCEPTION 'cobro: los totales de la venta % no son la suma de sus líneas, propinas y pagos', p_sale_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT kind INTO v_kind FROM journal_entries WHERE id = s.journal_entry_id AND location_id = s.location_id;
  IF v_kind IS DISTINCT FROM 'sale' THEN
    RAISE EXCEPTION 'cobro: el asiento de la venta % no es un asiento de venta', p_sale_id USING ERRCODE = 'check_violation';
  END IF;
  IF sales_entry_net(s.journal_entry_id, '1105') <> v_cash
     OR sales_entry_net(s.journal_entry_id, '1110') <> v_electronic - v_fees
     OR sales_entry_net(s.journal_entry_id, '5305') <> v_fees - (v_tips - v_payable)
     OR sales_entry_net(s.journal_entry_id, '4170') <> -v_service_net
     OR sales_entry_net(s.journal_entry_id, '4135') <> -v_product_net
     OR sales_entry_net(s.journal_entry_id, '2380') <> -v_payable
     OR sales_entry_net(s.journal_entry_id, '5105') <> v_commission
     OR sales_entry_net(s.journal_entry_id, '2335') <> -v_commission THEN
    RAISE EXCEPTION 'cobro: el asiento de la venta % no coincide con sus líneas, propinas y pagos', p_sale_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id AND a.location_id = l.location_id
     WHERE l.entry_id = s.journal_entry_id
       AND a.code NOT IN ('1105', '1110', '5305', '4170', '4135', '2380', '5105', '2335')
  ) THEN
    RAISE EXCEPTION 'cobro: el asiento de la venta % toca una cuenta que no es de ventas', p_sale_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- El efectivo solo entra a una caja abierta: la venta queda como movimiento de ese turno.
  IF v_cash > 0 AND NOT EXISTS (SELECT 1 FROM cash_movements WHERE journal_entry_id = s.journal_entry_id AND kind = 'sale') THEN
    RAISE EXCEPTION 'cobro: la venta % recibe efectivo sin caja abierta', p_sale_id USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

"""
build_data.py — сборка витрины для интерактивного дашборда.

Вход:  один CSV/XLS уровня строки заказа (Sample Superstore).
Выход: набор JSON в ./public/data/ — одна таблица фактов + справочники.

Принцип: в браузер уезжает ОДНА таблица фактов на зерне
(месяц × регион × сегмент × товар × клиент). Все агрегаты
(страна, канал, SKU, клиент, YoY, доли) считаются свёрткой этой таблицы
на фронте. Это гарантирует, что цифры в разных блоках не разъедутся:
физически негде разойтись, источник один.

Запуск:
    python build_data.py --src data/superstore.csv --out public/data
"""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

# ---------------------------------------------------------------- параметры

CURRENCY = "USD"

# Ожидаемые колонки исходника. Ключ — наше внутреннее имя.
COLUMNS = {
    "order_id": "Order ID",
    "order_date": "Order Date",
    "customer_id": "Customer ID",
    "customer_name": "Customer Name",
    "segment": "Segment",
    "region": "Region",
    "state": "State",
    "category": "Category",
    "subcategory": "Sub-Category",
    "product_id": "Product ID",
    "product_name": "Product Name",
    "sales": "Sales",
    "quantity": "Quantity",
    "discount": "Discount",
    "profit": "Profit",
}

# Порог для классификации спроса ADI×CV² (Syntetos–Boylan)
ADI_CUT = 1.32
CV2_CUT = 0.49


# ------------------------------------------------------------------ загрузка


def load_raw(path: Path) -> pd.DataFrame:
    if path.suffix.lower() in {".xlsx", ".xls"}:
        df = pd.read_csv(path) if False else pd.read_excel(path)
    else:
        # в Superstore часто встречается latin-1
        try:
            df = pd.read_csv(path, encoding="utf-8")
        except UnicodeDecodeError:
            df = pd.read_csv(path, encoding="latin-1")

    missing = [src for src in COLUMNS.values() if src not in df.columns]
    if missing:
        raise SystemExit(
            "В исходнике нет колонок: "
            + ", ".join(missing)
            + "\nЕсть: "
            + ", ".join(map(str, df.columns))
        )

    df = df[list(COLUMNS.values())].rename(columns={v: k for k, v in COLUMNS.items()})
    return df


def parse_dates(col: pd.Series) -> pd.Series:
    """
    Определяем порядок день/месяц по самим данным, а не на глаз.
    Если где-то первое поле > 12 — это день (DD/MM). Если второе > 12 — MM/DD.
    Оба сразу — файл смешанный, и тогда лучше упасть, чем молча съехать на год.
    """
    s = col.astype(str).str.strip()
    parts = s.str.extract(r"^(\d{1,2})\D(\d{1,2})\D(\d{2,4})$")
    if parts.notna().all(axis=None):
        a = parts[0].astype(int)
        b = parts[1].astype(int)
        first_is_day = bool((a > 12).any())
        second_is_day = bool((b > 12).any())
        if first_is_day and second_is_day:
            raise SystemExit("В Order Date смешаны DD/MM и MM/DD — файл битый")
        fmt = "%d/%m/%Y" if first_is_day else "%m/%d/%Y"
        out = pd.to_datetime(s, format=fmt, errors="coerce")
        print(f"[даты] распознан формат {fmt}")
        return out
    print("[даты] нестандартный формат, парсим автоопределением")
    return pd.to_datetime(s, errors="coerce")


def clean(df: pd.DataFrame, keep_duplicates: bool = False) -> tuple[pd.DataFrame, dict]:
    """Чистка с протоколом: что именно выброшено и почему."""
    log = {"rows_in": int(len(df))}

    df["order_date"] = parse_dates(df["order_date"])
    bad_date = int(df["order_date"].isna().sum())
    df = df[df["order_date"].notna()]

    for col in ("sales", "quantity", "discount", "profit"):
        df[col] = pd.to_numeric(df[col], errors="coerce")

    bad_num = int(df[["sales", "quantity", "profit"]].isna().any(axis=1).sum())
    df = df[df[["sales", "quantity", "profit"]].notna().all(axis=1)]

    zero_sales = int((df["sales"] <= 0).sum())
    df = df[df["sales"] > 0]

    # Полные дубликаты строк заказа.
    # Спорный случай: одинаковый заказ + товар + количество + сумма может быть
    # и ошибкой ввода, и двумя отдельными позициями одного SKU в одном заказе.
    # По умолчанию считаем ошибкой; --keep-duplicates оставляет как есть.
    dupes = int(df.duplicated().sum())
    dup_sales = round(float(df[df.duplicated()]["sales"].sum()), 2)
    if not keep_duplicates:
        df = df[~df.duplicated()]

    for col in ("segment", "region", "state", "category", "subcategory"):
        df[col] = df[col].astype(str).str.strip()

    log.update(
        {
            "dropped_bad_date": bad_date,
            "dropped_bad_numeric": bad_num,
            "dropped_nonpositive_sales": zero_sales,
            "duplicates_found": dupes,
            "duplicates_dropped": 0 if keep_duplicates else dupes,
            "duplicates_sales_effect": dup_sales,
            "rows_out": int(len(df)),
        }
    )
    return df.reset_index(drop=True), log


# ------------------------------------------------------------------ периоды


def build_periods(df: pd.DataFrame) -> dict:
    """
    Сравнение по календарным годам: последний год с полными 12 месяцами
    против предыдущего. "3 месяца" — четвёртый квартал того же года
    против четвёртого квартала года назад.

    Отдельно считаем покрытие: сколько дней в периоде реально закрыто
    данными. Если хвост года обрезан, это должно быть видно на странице,
    а не всплыть в вопросе "почему декабрь просел".
    """
    by_year = df.groupby(df["order_date"].dt.year)["order_date"]
    full = [int(y) for y, g in by_year if g.dt.month.nunique() == 12]
    if len(full) < 2:
        raise SystemExit("В данных нет двух полных календарных лет для сравнения")
    cur_y, pri_y = full[-1], full[-2]

    months = lambda y: [f"{y}-{m:02d}" for m in range(1, 13)]
    quarter = lambda y: [f"{y}-{m:02d}" for m in (10, 11, 12)]

    def coverage(y: int) -> dict:
        g = df[df["order_date"].dt.year == y]["order_date"]
        year_end = pd.Timestamp(year=y, month=12, day=31)
        last = g.max()
        return {
            "first_order": str(g.min().date()),
            "last_order": str(last.date()),
            "days_missing_at_tail": int((year_end - last).days),
            "rows": int(len(g)),
        }

    return {
        "mode": "calendar_year",
        "year": {
            "current": months(cur_y), "prior": months(pri_y),
            "current_label": str(cur_y), "prior_label": str(pri_y),
        },
        "quarter": {
            "current": quarter(cur_y), "prior": quarter(pri_y),
            "current_label": f"Q4 {cur_y}", "prior_label": f"Q4 {pri_y}",
        },
        "coverage": {str(cur_y): coverage(cur_y), str(pri_y): coverage(pri_y)},
        "data_range": [str(df["order_date"].min().date()), str(df["order_date"].max().date())],
    }


# --------------------------------------------------------- паттерн спроса


def demand_pattern(monthly_qty: pd.Series, n_months: int) -> tuple[float, float, str]:
    """
    ADI  — средний интервал между месяцами со спросом.
    CV²  — квадрат коэффициента вариации объёма в месяцах со спросом.
    Классы: Smooth / Intermittent / Erratic / Lumpy.
    """
    active = monthly_qty[monthly_qty > 0]
    if len(active) == 0:
        return (float("nan"), float("nan"), "no-demand")

    adi = n_months / len(active)
    mean = active.mean()
    cv2 = float((active.std(ddof=0) / mean) ** 2) if mean > 0 and len(active) > 1 else 0.0

    if adi < ADI_CUT and cv2 < CV2_CUT:
        cls = "smooth"
    elif adi >= ADI_CUT and cv2 < CV2_CUT:
        cls = "intermittent"
    elif adi < ADI_CUT and cv2 >= CV2_CUT:
        cls = "erratic"
    else:
        cls = "lumpy"
    return (round(adi, 2), round(cv2, 2), cls)


# ------------------------------------------------------------- справочники


def encode(values: pd.Series) -> tuple[list[str], dict[str, int]]:
    uniq = sorted(values.dropna().unique().tolist())
    return uniq, {v: i for i, v in enumerate(uniq)}


def price_groups(df: pd.DataFrame) -> pd.Series:
    """
    Ценовая группа — цена товара относительно ДРУГИХ ТОВАРОВ ТОЙ ЖЕ КАТЕГОРИИ,
    а не всего каталога: стулья сравниваются со стульями.
    Терцили по медианной цене за единицу.
    """
    unit = df["sales"] / df["quantity"].clip(lower=1)
    tmp = pd.DataFrame(
        {"product_id": df["product_id"], "category": df["category"], "unit": unit}
    )
    med = tmp.groupby(["category", "product_id"], as_index=False)["unit"].median()

    def bucket(g: pd.DataFrame) -> pd.Series:
        if len(g) < 3:
            return pd.Series(["mid"] * len(g), index=g.index)
        return pd.qcut(
            g["unit"].rank(method="first"), 3, labels=["low", "mid", "high"]
        ).astype(str)

    med["price_group"] = (
        med.groupby("category", group_keys=False)[["unit"]]
        .apply(lambda g: bucket(med.loc[g.index]))
    )
    return med.set_index("product_id")["price_group"]


# ------------------------------------------------------------------- сборка


def build(df: pd.DataFrame) -> dict:
    df = df.copy()
    df["month"] = df["order_date"].dt.to_period("M").astype(str)

    # Скидка — отдельное измерение витрины, а не атрибут строки.
    # Без неё нельзя показать главный эффект в данных: где скидка
    # перестаёт окупаться. Три корзины, границы взяты по обрыву маржи.
    df["disc_bucket"] = pd.cut(
        df["discount"], bins=[-0.001, 0.0001, 0.2001, 1.0],
        labels=["none", "upto20", "over20"],
    ).astype(str)

    months, m_ix = encode(df["month"])
    regions, r_ix = encode(df["region"])
    segments, s_ix = encode(df["segment"])
    discs, d_ix = encode(df["disc_bucket"])

    # --- справочник товаров
    prod = (
        df.groupby("product_id")
        .agg(
            name=("product_name", "first"),
            category=("category", "first"),
            subcategory=("subcategory", "first"),
        )
        .reset_index()
    )
    pg = price_groups(df)
    prod["price_group"] = prod["product_id"].map(pg).fillna("mid")

    n_months = len(months)
    qty_by_pm = df.pivot_table(
        index="product_id", columns="month", values="quantity", aggfunc="sum", fill_value=0
    )
    pattern = qty_by_pm.apply(lambda row: demand_pattern(row, n_months), axis=1)
    prod["adi"] = [p[0] for p in pattern.loc[prod["product_id"]]]
    prod["cv2"] = [p[1] for p in pattern.loc[prod["product_id"]]]
    prod["pattern"] = [p[2] for p in pattern.loc[prod["product_id"]]]

    products = prod.sort_values("product_id").reset_index(drop=True)
    p_ix = {pid: i for i, pid in enumerate(products["product_id"])}

    # --- паттерн спроса на уровне подкатегории
    # На уровне SKU в этом датасете 4 года истории дают единицы заказов
    # на товар — ADI там почти всегда «редкий», и класс малоинформативен.
    # На подкатегории история плотная, классификация имеет смысл.
    qty_by_sm = df.pivot_table(
        index="subcategory", columns="month", values="quantity",
        aggfunc="sum", fill_value=0,
    )
    sub_rows = []
    for name, row in qty_by_sm.iterrows():
        adi, cv2, cls = demand_pattern(row, n_months)
        sub_rows.append(
            {
                "subcategory": name,
                "category": df.loc[df["subcategory"] == name, "category"].iloc[0],
                "adi": adi,
                "cv2": cv2,
                "pattern": cls,
                "months_with_demand": int((row > 0).sum()),
            }
        )
    subcategories = sorted(sub_rows, key=lambda r: r["subcategory"])

    # --- справочник клиентов
    cust = (
        df.groupby("customer_id")
        .agg(name=("customer_name", "first"), segment=("segment", "first"))
        .reset_index()
        .sort_values("customer_id")
        .reset_index(drop=True)
    )
    c_ix = {cid: i for i, cid in enumerate(cust["customer_id"])}

    # --- таблица заказов (отдельное зерно — для точного счёта количества заказов)
    # order_id соответствует ровно одному месяцу/региону/сегменту/клиенту —
    # проверено на исходнике (ни одного заказа с двумя регионами, сегментами,
    # клиентами или датами). Внутри заказа может отличаться только product_id
    # и disc_bucket, поэтому nunique(order_id) на зерне таблицы фактов задваивает
    # (в среднем ×2) заказы с несколькими позициями. Считаем на своём, верном
    # зерне, а не полем в facts — там его физически нельзя посчитать правильно.
    orders_tbl = (
        df.groupby("order_id")
        .agg(
            month=("month", "first"),
            region=("region", "first"),
            segment=("segment", "first"),
            customer_id=("customer_id", "first"),
        )
        .reset_index()
    )
    orders_rows = np.column_stack(
        [
            orders_tbl["month"].map(m_ix).to_numpy(),
            orders_tbl["region"].map(r_ix).to_numpy(),
            orders_tbl["segment"].map(s_ix).to_numpy(),
            orders_tbl["customer_id"].map(c_ix).to_numpy(),
        ]
    ).tolist()

    # --- таблица фактов
    facts = (
        df.groupby(["month", "region", "segment", "disc_bucket", "product_id", "customer_id"])
        .agg(
            sales=("sales", "sum"),
            profit=("profit", "sum"),
            qty=("quantity", "sum"),
        )
        .reset_index()
    )

    rows = np.column_stack(
        [
            facts["month"].map(m_ix).to_numpy(),
            facts["region"].map(r_ix).to_numpy(),
            facts["segment"].map(s_ix).to_numpy(),
            facts["disc_bucket"].map(d_ix).to_numpy(),
            facts["product_id"].map(p_ix).to_numpy(),
            facts["customer_id"].map(c_ix).to_numpy(),
            facts["sales"].round(2).to_numpy(),
            facts["profit"].round(2).to_numpy(),
            facts["qty"].to_numpy(),
        ]
    ).tolist()

    return {
        "dims": {
            "months": months,
            "regions": regions,
            "segments": segments,
            "discounts": discs,
            "categories": sorted(df["category"].unique().tolist()),
            "subcategories": sorted(df["subcategory"].unique().tolist()),
        },
        "products": products.to_dict(orient="records"),
        "subcategories": subcategories,
        "customers": cust.to_dict(orient="records"),
        "facts": {
            "columns": [
                "month", "region", "segment", "disc", "product", "customer",
                "sales", "profit", "qty",
            ],
            "rows": rows,
        },
        "orders": {
            "columns": ["month", "region", "segment", "customer"],
            "rows": orders_rows,
        },
    }


# --------------------------------------------------------------- сверка сумм


def verify(df: pd.DataFrame, built: dict) -> dict:
    """
    Витрина обязана сходиться с сырьём до копейки.
    Если не сходится — пайплайн врёт, и дашборд построен на вранье.
    """
    cols = built["facts"]["columns"]
    arr = pd.DataFrame(built["facts"]["rows"], columns=cols)

    checks = {
        "sales_raw": round(float(df["sales"].sum()), 2),
        "sales_mart": round(float(arr["sales"].sum()), 2),
        "profit_raw": round(float(df["profit"].sum()), 2),
        "profit_mart": round(float(arr["profit"].sum()), 2),
        "qty_raw": int(df["quantity"].sum()),
        "qty_mart": int(arr["qty"].sum()),
        "orders_raw": int(df["order_id"].nunique()),
        "products_raw": int(df["product_id"].nunique()),
        "products_mart": int(len(built["products"])),
        "customers_raw": int(df["customer_id"].nunique()),
        "customers_mart": int(len(built["customers"])),
        "fact_rows": int(len(arr)),
        "orders_mart": int(len(built["orders"]["rows"])),
    }
    checks["orders_ok"] = checks["orders_raw"] == checks["orders_mart"]
    # Витрина округлена до копеек — накопленный дрейф показываем явно,
    # а не прячем за порогом сравнения.
    checks["sales_drift"] = round(checks["sales_mart"] - checks["sales_raw"], 2)
    checks["profit_drift"] = round(checks["profit_mart"] - checks["profit_raw"], 2)
    checks["sales_drift_ppm"] = round(
        1e6 * abs(checks["sales_drift"]) / max(checks["sales_raw"], 1), 2
    )
    checks["sales_ok"] = abs(checks["sales_raw"] - checks["sales_mart"]) < 0.5
    checks["profit_ok"] = abs(checks["profit_raw"] - checks["profit_mart"]) < 0.5
    checks["qty_ok"] = checks["qty_raw"] == checks["qty_mart"]
    checks["dims_ok"] = (
        checks["products_raw"] == checks["products_mart"]
        and checks["customers_raw"] == checks["customers_mart"]
    )
    checks["passed"] = all(
        checks[k] for k in ("sales_ok", "profit_ok", "qty_ok", "dims_ok", "orders_ok")
    )
    return checks


def orders_by_year(df: pd.DataFrame, periods: dict) -> dict:
    """Independent per-year distinct-order counts, for test_rollup.mjs to check
    the page's order count against — not derived from the fact table at all."""
    by_year = df.groupby(df["order_date"].dt.year)["order_id"].nunique()
    cur_y = int(periods["year"]["current_label"])
    pri_y = int(periods["year"]["prior_label"])
    return {"current": int(by_year.get(cur_y, 0)), "prior": int(by_year.get(pri_y, 0))}


# ---------------------------------------------------------------------- main


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, type=Path)
    ap.add_argument("--out", default=Path("public/data"), type=Path)
    ap.add_argument(
        "--keep-duplicates",
        action="store_true",
        help="не удалять полные дубликаты строк заказа",
    )
    args = ap.parse_args()

    raw = load_raw(args.src)
    df, clean_log = clean(raw, keep_duplicates=args.keep_duplicates)
    periods = build_periods(df)
    built = build(df)
    checks = verify(df, built)
    checks["orders_by_year"] = orders_by_year(df, periods)

    args.out.mkdir(parents=True, exist_ok=True)

    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": args.src.name,
        "currency": CURRENCY,
        "grain": "month × region × segment × disc_bucket × product × customer",
        "periods": periods,
        "cleaning": clean_log,
        "checks": checks,
        "dims": built["dims"],
        "thresholds": {"adi": ADI_CUT, "cv2": CV2_CUT},
    }

    def dump(name: str, obj) -> int:
        p = args.out / name
        # explicit utf-8: default encoding falls back to the OS codepage (e.g.
        # cp1251 on Windows), which can't hold the "×" in meta.grain and crashes
        p.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        return p.stat().st_size

    sizes = {
        "meta.json": dump("meta.json", meta),
        "products.json": dump("products.json", built["products"]),
        "subcategories.json": dump("subcategories.json", built["subcategories"]),
        "customers.json": dump("customers.json", built["customers"]),
        "facts.json": dump("facts.json", built["facts"]),
        "orders.json": dump("orders.json", built["orders"]),
    }

    print("--- очистка ---")
    for k, v in clean_log.items():
        print(f"  {k:32} {v}")
    print("--- сверка витрины с сырьём ---")
    for k, v in checks.items():
        print(f"  {k:32} {v}")
    print("--- выгрузка ---")
    total = 0
    for k, v in sizes.items():
        total += v
        print(f"  {k:32} {v/1024:8.1f} KB")
    print(f"  {'ИТОГО':32} {total/1024:8.1f} KB")

    if not checks["passed"]:
        raise SystemExit("СВЕРКА НЕ ПРОШЛА — витрина не совпадает с исходником")


if __name__ == "__main__":
    main()

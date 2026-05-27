"use client";

import { useEffect, useMemo, useState } from "react";

const MARKET_SEARCH_STORAGE_KEY = "yunyun-market-search-state-v2";

const RARITIES = ["Normal", "Unique", "Rare", "Legendary", "Fabled", "Mythic", "Set"];
const ITEM_TYPES = [
  "Weapon",
  "Armour",
  "Accessory",
  "MaterialItem",
  "PowderItem",
  "AmplifierItem",
  "EmeraldPouchItem",
];
const SUB_TYPES = [
  "Bow",
  "Wand",
  "Spear",
  "Dagger",
  "Relik",
  "Helmet",
  "Chestplate",
  "Leggings",
  "Boots",
  "Ring",
  "Bracelet",
  "Necklace",
];
const SERVER_SORTS = [
  ["timestamp_desc", "Newest"],
  ["timestamp_asc", "Oldest"],
  ["listing_price_asc", "Price low"],
  ["listing_price_desc", "Price high"],
  ["overall_roll_desc", "Roll high"],
  ["overall_roll_asc", "Roll low"],
];
const LOCAL_SORTS = [
  ["api", "API order"],
  ["price_asc", "Price low"],
  ["price_desc", "Price high"],
  ["overall_desc", "Roll high"],
  ["weighted_desc", "Sum high"],
];
const COMMON_STATS = [
  "strength",
  "dexterity",
  "intelligence",
  "defence",
  "agility",
  "speed",
  "walkSpeed",
  "spellDamage",
  "mainAttackDamage",
  "healthRegen",
  "manaRegen",
  "manaSteal",
  "lifeSteal",
  "xpBonus",
  "lootBonus",
  "thorns",
  "reflection",
  "exploding",
  "poison",
];
const DEFAULT_QUERY = {
  itemName: "",
  rarity: "",
  shiny: "",
  unidentified: "",
  tier: "",
  priceMin: "",
  priceMax: "",
  itemType: "",
  subType: "",
  sort: "timestamp_desc",
  page: "1",
  pageSize: "1000",
};

let nextId = 0;

function makeClientId(prefix) {
  nextId += 1;
  return `${prefix}-${Date.now().toString(36)}-${nextId}`;
}

function createRule(overrides = {}) {
  return {
    id: overrides.id ?? makeClientId("rule"),
    max: "",
    min: "",
    stat: "",
    weight: "1",
    ...overrides,
  };
}

function createGroup(overrides = {}) {
  return {
    enabled: true,
    id: overrides.id ?? makeClientId("group"),
    operator: "weighted",
    rows: [createRule()],
    ...overrides,
  };
}

function createInitialGroups() {
  return [];
}

export default function MarketBoard() {
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [groups, setGroups] = useState(createInitialGroups);
  const [groupPickerOpen, setGroupPickerOpen] = useState(false);
  const [localSort, setLocalSort] = useState("api");
  const [items, setItems] = useState([]);
  const [serverMeta, setServerMeta] = useState(null);
  const [selectedHash, setSelectedHash] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [priceState, setPriceState] = useState({
    data: null,
    error: "",
    itemName: "",
    loading: false,
  });

  useEffect(() => {
    try {
      const savedState = window.localStorage.getItem(MARKET_SEARCH_STORAGE_KEY);

      if (savedState) {
        const parsed = JSON.parse(savedState);
        const hydrateTimer = window.setTimeout(() => {
          setQuery({ ...DEFAULT_QUERY, ...parsed.query });
          setGroups(
            Array.isArray(parsed.groups) ? parsed.groups : createInitialGroups(),
          );
          setLocalSort(parsed.localSort ?? "api");
        }, 0);

        return () => window.clearTimeout(hydrateTimer);
      }
    } catch {
      window.localStorage.removeItem(MARKET_SEARCH_STORAGE_KEY);
    }
    return undefined;
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        MARKET_SEARCH_STORAGE_KEY,
        JSON.stringify({ groups, localSort, query }),
      );
    } catch {
      // Local storage is optional for this tool.
    }
  }, [groups, localSort, query]);

  const statNames = useMemo(() => {
    const collected = new Set(COMMON_STATS);
    items.forEach((item) => {
      Object.keys(item.stat_rolls ?? {}).forEach((stat) => collected.add(stat));
    });
    return [...collected].sort((a, b) => a.localeCompare(b));
  }, [items]);

  const evaluatedItems = useMemo(() => {
    const rows = items
      .filter((item) => passesLocalPriceFilter(item, query))
      .map((item) => ({
        item,
        meta: evaluateAllGroups(item, groups),
      }))
      .filter((entry) => entry.meta.passed);

    return sortEvaluatedItems(rows, localSort).map((entry) => entry.item);
  }, [groups, items, localSort, query]);

  const selectedItem = useMemo(() => {
    if (!evaluatedItems.length) {
      return null;
    }
    return (
      evaluatedItems.find((item) => getListingKey(item) === selectedHash) ??
      evaluatedItems[0]
    );
  }, [evaluatedItems, selectedHash]);

  const activeMeta = useMemo(
    () => (selectedItem ? evaluateAllGroups(selectedItem, groups) : null),
    [groups, selectedItem],
  );

  useEffect(() => {
    if (!selectedItem?.name) {
      return;
    }

    let active = true;
    const itemName = selectedItem.name;
    const params = new URLSearchParams({ name: selectedItem.name });

    if (selectedItem.shiny_stat) {
      params.set("shiny", "true");
    }
    if (selectedItem.tier !== null && selectedItem.tier !== undefined) {
      params.set("tier", String(selectedItem.tier));
    }

    fetch(`/api/wynnventory/price?${params.toString()}`, {
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error ?? data.message ?? "Price lookup failed");
        }
        return data;
      })
      .then((data) => {
        if (active) {
          setPriceState({ data, error: "", itemName, loading: false });
        }
      })
      .catch((priceError) => {
        if (active) {
          setPriceState({
            data: null,
            error:
              priceError instanceof Error
                ? priceError.message
                : "Price lookup failed",
            itemName,
            loading: false,
          });
        }
      });

    return () => {
      active = false;
    };
  }, [selectedItem?.name, selectedItem?.shiny_stat, selectedItem?.tier]);

  async function handleSearch(event) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const params = buildListingParams(query);
      const response = await fetch(`/api/wynnventory/listings?${params.toString()}`, {
        headers: { Accept: "application/json" },
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error ?? data.message ?? "Market lookup failed");
      }

      const nextItems = Array.isArray(data.items) ? data.items : [];
      setItems(nextItems);
      setServerMeta({
        count: data.count ?? nextItems.length,
        page: data.page ?? Number(query.page),
        pageSize: data.page_size ?? Number(query.pageSize),
        total: data.total ?? nextItems.length,
      });
      setSelectedHash(nextItems[0] ? getListingKey(nextItems[0]) : "");
    } catch (searchError) {
      setItems([]);
      setServerMeta(null);
      setSelectedHash("");
      setError(
        searchError instanceof Error ? searchError.message : "Market lookup failed",
      );
    } finally {
      setLoading(false);
    }
  }

  function updateQuery(key, value) {
    setQuery((previous) => ({ ...previous, [key]: value }));
  }

  function addGroup() {
    setGroups((previous) => [...previous, createGroup()]);
    setGroupPickerOpen(false);
    setLocalSort("weighted_desc");
  }

  function updateGroup(groupId, patch) {
    setGroups((previous) =>
      previous.map((group) => (group.id === groupId ? { ...group, ...patch } : group)),
    );
  }

  function removeGroup(groupId) {
    setGroups((previous) => previous.filter((group) => group.id !== groupId));
  }

  function addRule(groupId) {
    setGroups((previous) =>
      previous.map((group) =>
        group.id === groupId
          ? { ...group, rows: [...group.rows, createRule()] }
          : group,
      ),
    );
  }

  function updateRule(groupId, ruleId, patch) {
    setGroups((previous) =>
      previous.map((group) =>
        group.id === groupId
          ? {
              ...group,
              rows: group.rows.map((row) =>
                row.id === ruleId ? { ...row, ...patch } : row,
              ),
            }
          : group,
      ),
    );
  }

  function removeRule(groupId, ruleId) {
    setGroups((previous) =>
      previous.map((group) =>
        group.id === groupId
          ? {
              ...group,
              rows:
                group.rows.length > 1
                  ? group.rows.filter((row) => row.id !== ruleId)
                  : group.rows,
            }
          : group,
      ),
    );
  }

  return (
    <main className="app-shell market-shell">
      <header className="market-hero">
        <div>
          <p className="eyebrow">WynnVentory Market</p>
          <h1>Trade Market Search</h1>
        </div>
        <button
          className="tool-button primary market-hero-action"
          disabled={loading}
          type="button"
          onClick={handleSearch}
        >
          {loading ? "Searching" : "Search Market"}
        </button>
      </header>

      <section className="market-grid">
        <aside className="market-filters">
          <form className="panel market-panel" onSubmit={handleSearch}>
            <div className="panel-heading compact">
              <div>
                <p className="eyebrow">Trade filters</p>
                <h2>Market Query</h2>
              </div>
            </div>
            <div className="market-control-grid">
              <label className="field-label">
                Name
                <input
                  placeholder="Divzer"
                  value={query.itemName}
                  onChange={(event) => updateQuery("itemName", event.target.value)}
                />
              </label>
              <label className="field-label">
                Rarity
                <select
                  value={query.rarity}
                  onChange={(event) => updateQuery("rarity", event.target.value)}
                >
                  <option value="">Any</option>
                  {RARITIES.map((rarity) => (
                    <option key={rarity} value={rarity}>
                      {rarity}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                Item type
                <select
                  value={query.itemType}
                  onChange={(event) => updateQuery("itemType", event.target.value)}
                >
                  <option value="">Any</option>
                  {ITEM_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                Sub type
                <select
                  value={query.subType}
                  onChange={(event) => updateQuery("subType", event.target.value)}
                >
                  <option value="">Any</option>
                  {SUB_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                Shiny
                <select
                  value={query.shiny}
                  onChange={(event) => updateQuery("shiny", event.target.value)}
                >
                  <option value="">Any</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </label>
              <label className="field-label">
                Identified
                <select
                  value={query.unidentified}
                  onChange={(event) =>
                    updateQuery("unidentified", event.target.value)
                  }
                >
                  <option value="">Any</option>
                  <option value="false">Identified</option>
                  <option value="true">Unidentified</option>
                </select>
              </label>
              <label className="field-label">
                Tier
                <input
                  inputMode="numeric"
                  min="1"
                  type="number"
                  value={query.tier}
                  onChange={(event) => updateQuery("tier", event.target.value)}
                />
              </label>
              <label className="field-label">
                Price min
                <input
                  inputMode="numeric"
                  min="0"
                  placeholder="emeralds"
                  type="number"
                  value={query.priceMin}
                  onChange={(event) => updateQuery("priceMin", event.target.value)}
                />
              </label>
              <label className="field-label">
                Price max
                <input
                  inputMode="numeric"
                  min="0"
                  placeholder="10000"
                  type="number"
                  value={query.priceMax}
                  onChange={(event) => updateQuery("priceMax", event.target.value)}
                />
              </label>
              <label className="field-label">
                API sort
                <select
                  value={query.sort}
                  onChange={(event) => updateQuery("sort", event.target.value)}
                >
                  {SERVER_SORTS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                Page
                <input
                  min="1"
                  type="number"
                  value={query.page}
                  onChange={(event) => updateQuery("page", event.target.value)}
                />
              </label>
              <label className="field-label">
                Page size
                <input
                  max="1000"
                  min="1"
                  type="number"
                  value={query.pageSize}
                  onChange={(event) => updateQuery("pageSize", event.target.value)}
                />
              </label>
            </div>
            <div className="button-row">
              <button className="tool-button primary" disabled={loading} type="submit">
                {loading ? "Searching" : "Search Market"}
              </button>
              <button
                className="tool-button"
                type="button"
                onClick={() => {
                  setQuery(DEFAULT_QUERY);
                  setGroups(createInitialGroups());
                  setLocalSort("api");
                }}
              >
                Reset
              </button>
            </div>
          </form>

          <section className="panel market-panel">
            <div className="panel-heading compact">
              <div>
                <p className="eyebrow">Stat filters</p>
                <h2>Advanced Groups</h2>
              </div>
              <div className="heading-actions">
                <button
                  className="tool-button"
                  type="button"
                  onClick={() => setGroupPickerOpen((open) => !open)}
                >
                  + Group
                </button>
              </div>
            </div>
            {groupPickerOpen ? (
              <div className="group-picker">
                <button className="group-type-option" type="button" onClick={addGroup}>
                  <strong>Weighted Sum</strong>
                  <span>Sum selected stat roll percentages with custom weights.</span>
                </button>
              </div>
            ) : null}
            <datalist id="market-stat-names">
              {statNames.map((stat) => (
                <option key={stat} value={stat} />
              ))}
            </datalist>
            <div className="filter-groups">
              {groups.length === 0 ? (
                <div className="empty-state">Add a group, then choose Weighted Sum.</div>
              ) : null}
              {groups.map((group, index) => (
                <WeightedSumGroup
                  group={group}
                  index={index}
                  key={group.id}
                  onAddRule={() => addRule(group.id)}
                  onRemoveGroup={() => removeGroup(group.id)}
                  onRemoveRule={(ruleId) => removeRule(group.id, ruleId)}
                  onUpdateGroup={(patch) => updateGroup(group.id, patch)}
                  onUpdateRule={(ruleId, patch) =>
                    updateRule(group.id, ruleId, patch)
                  }
                />
              ))}
            </div>
          </section>
        </aside>

        <section className="market-results panel">
          <div className="panel-heading compact market-results-head">
            <div>
              <p className="eyebrow">Results</p>
              <h2>{evaluatedItems.length} Listings</h2>
            </div>
            <div className="market-result-tools">
              <label className="field-label">
                Local sort
                <select
                  value={localSort}
                  onChange={(event) => setLocalSort(event.target.value)}
                >
                  {LOCAL_SORTS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          <div className="market-summary-row">
            <span>{serverMeta ? `${serverMeta.total} API matches` : "No API search yet"}</span>
            <span>{groups.filter((group) => group.enabled).length} active groups</span>
            <span>{items.length} loaded</span>
          </div>
          {error ? <p className="warning-line">{error}</p> : null}
          {!items.length && !error ? (
            <div className="empty-state">Enter market filters and search.</div>
          ) : null}
          {items.length && !evaluatedItems.length ? (
            <div className="empty-state">No listings match the active stat groups.</div>
          ) : null}
          <div className="listing-list">
            {evaluatedItems.slice(0, 250).map((item) => {
              const itemMeta = evaluateAllGroups(item, groups);
              const active = selectedItem && getListingKey(item) === getListingKey(selectedItem);
              return (
                <ListingCard
                  active={active}
                  item={item}
                  key={getListingKey(item)}
                  meta={itemMeta}
                  onSelect={() => setSelectedHash(getListingKey(item))}
                />
              );
            })}
          </div>
        </section>

        <aside className="market-detail">
          <ItemDetailPanel
            item={selectedItem}
            meta={activeMeta}
            priceState={priceState}
          />
        </aside>
      </section>
    </main>
  );
}

function WeightedSumGroup({
  group,
  index,
  onAddRule,
  onRemoveGroup,
  onRemoveRule,
  onUpdateGroup,
  onUpdateRule,
}) {
  return (
    <section className={group.enabled ? "filter-group" : "filter-group disabled"}>
      <div className="filter-group-head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", width: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <input
            checked={group.enabled}
            type="checkbox"
            style={{ width: "14px", height: "14px", margin: 0, cursor: "pointer" }}
            onChange={(event) => onUpdateGroup({ enabled: event.target.checked })}
          />
          <span style={{ fontSize: "0.85rem", fontWeight: "600" }}>
            Weighted Sum #{index + 1}
          </span>
        </div>
        <button
          aria-label="remove group"
          className="icon-button"
          type="button"
          style={{ marginLeft: "auto" }}
          onClick={onRemoveGroup}
        >
          x
        </button>
      </div>
      <div className="filter-rule-list">
        {group.rows.map((row) => (
          <WeightedStatRow
            key={row.id}
            row={row}
            onRemove={() => onRemoveRule(row.id)}
            onUpdate={(patch) => onUpdateRule(row.id, patch)}
          />
        ))}
      </div>
      <button className="tool-button filter-add-rule" type="button" onClick={onAddRule}>
        + Stat
      </button>
    </section>
  );
}

function WeightedStatRow({ row, onRemove, onUpdate }) {
  return (
    <div className="filter-rule weighted-rule">
      <input
        list="market-stat-names"
        placeholder="stat name"
        value={row.stat}
        onChange={(event) => onUpdate({ stat: event.target.value })}
      />
      <input
        aria-label="stat weight"
        placeholder="weight"
        type="number"
        value={row.weight}
        onChange={(event) => onUpdate({ weight: event.target.value })}
      />
      <input
        aria-label="minimum value"
        placeholder="min"
        type="number"
        value={row.min}
        onChange={(event) => onUpdate({ min: event.target.value })}
      />
      <input
        aria-label="maximum value"
        placeholder="max"
        type="number"
        value={row.max}
        onChange={(event) => onUpdate({ max: event.target.value })}
      />
      <button
        aria-label="remove stat"
        className="icon-button"
        type="button"
        onClick={onRemove}
      >
        -
      </button>
    </div>
  );
}

function ListingCard({ active, item, meta, onSelect }) {
  const statEntries = Object.entries(item.stat_rolls ?? {})
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 5);
  const weightedLabel = Number.isFinite(meta.weightedTotal)
    ? `Sum ${formatNumber(meta.weightedTotal)}`
    : "No sum";

  return (
    <button
      className={active ? "listing-card active" : "listing-card"}
      type="button"
      onClick={onSelect}
    >
      <ItemIcon icon={item.icon} name={item.name} />
      <div className="listing-main">
        <div className="listing-title-row">
          <strong>{item.name}</strong>
          <span>{formatEmeralds(item.listing_price)}</span>
        </div>
        <div className="listing-tags">
          <span>{item.rarity ?? "Unknown"}</span>
          <span>{item.type ?? item.item_type ?? "Item"}</span>
          <span>{item.unidentified ? "Unidentified" : `${formatNumber(item.overall_roll)}%`}</span>
        </div>
        <div className="listing-stats">
          {statEntries.length ? (
            statEntries.map(([stat, value]) => (
              <span key={stat}>
                {formatStatName(stat)} {formatNumber(value)}%
              </span>
            ))
          ) : (
            <span>No stat rolls</span>
          )}
        </div>
      </div>
      <div className="listing-side">
        <span className="weighted-sum-badge">{weightedLabel}</span>
        <small>{item.playerName ?? item.player_name ?? "seller"}</small>
      </div>
    </button>
  );
}

function ItemDetailPanel({ item, meta, priceState }) {
  if (!item) {
    return (
      <section className="panel market-panel market-detail-panel">
        <div className="panel-heading compact">
          <div>
            <p className="eyebrow">Item</p>
            <h2>Details</h2>
          </div>
        </div>
        <div className="empty-state">Select a listing.</div>
      </section>
    );
  }

  const stats = Object.entries(item.stat_rolls ?? {}).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  const priceBelongsToItem = priceState.itemName === item.name;

  return (
    <section className="panel market-panel market-detail-panel">
      <div className="detail-head">
        <ItemIcon icon={item.icon} name={item.name} />
        <div>
          <p className="eyebrow">{item.rarity ?? "Market item"}</p>
          <h2>{item.name}</h2>
          <div className="listing-tags detail-tags">
            <span>{item.item_type ?? "Item"}</span>
            <span>{item.type ?? "Subtype"}</span>
            <span>{item.amount ?? 1} listed</span>
          </div>
        </div>
      </div>

      <div className="detail-price">
        <span>Listing price</span>
        <strong>{formatEmeralds(item.listing_price)}</strong>
        <small>{formatNumber(item.listing_price)} emeralds</small>
      </div>

      <div className="market-summary-row detail-meta">
        <span>{item.unidentified ? "Unidentified" : "Identified"}</span>
        <span>Reroll {item.reroll_count ?? 0}</span>
        <span>{item.shiny_stat ? `Shiny ${item.shiny_stat}` : "Not shiny"}</span>
      </div>

      {meta ? (
        <div className="detail-filter-score">
          <strong>{meta.matchedGroups}/{meta.activeGroups}</strong>
          <span>groups matched</span>
          <strong>
            {Number.isFinite(meta.weightedTotal)
              ? formatNumber(meta.weightedTotal)
              : "-"}
          </strong>
          <span>weighted score</span>
        </div>
      ) : null}

      <div className="detail-section">
        <h3>Price Stats</h3>
        {!priceBelongsToItem ? (
          <p className="muted tight">Loading price stats...</p>
        ) : null}
        {priceBelongsToItem && priceState.error ? (
          <p className="warning-line">{priceState.error}</p>
        ) : null}
        {priceBelongsToItem && priceState.data ? (
          <PriceStats stats={priceState.data} />
        ) : null}
      </div>

      <div className="detail-section">
        <h3>Stat Rolls</h3>
        <div className="detail-stat-list">
          {stats.length ? (
            stats.map(([stat, value]) => (
              <div className="detail-stat-row" key={stat}>
                <span>{formatStatName(stat)}</span>
                <strong>{formatNumber(value)}%</strong>
              </div>
            ))
          ) : (
            <p className="muted tight">No stat roll data.</p>
          )}
        </div>
      </div>

      <div className="detail-section detail-foot">
        <span>{formatDate(item.timestamp)}</span>
        <span>{item.hash_code ?? "no hash"}</span>
      </div>
    </section>
  );
}

function PriceStats({ stats }) {
  const rows = [
    ["Lowest", stats.lowest_price],
    ["Median", stats.p50_price],
    ["Mid 80%", stats.average_mid_80_percent_price],
    ["EMA P50", stats.average_p50_ema_price],
    ["Average", stats.average_price],
    ["Count", stats.total_count],
  ];

  return (
    <div className="price-stat-grid">
      {rows.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>
            {label === "Count" ? formatNumber(value) : formatEmeralds(value)}
          </strong>
        </div>
      ))}
    </div>
  );
}

function ItemIcon({ icon, name }) {
  const canRenderImage = typeof icon === "string" && /^https?:\/\//.test(icon);

  if (canRenderImage) {
    return (
      <span
        className="item-icon item-icon-image"
        style={{ backgroundImage: `url("${icon}")` }}
        aria-hidden="true"
      />
    );
  }

  return (
    <span className="item-icon item-icon-fallback" aria-hidden="true">
      {name ? name.slice(0, 2).toUpperCase() : "IT"}
    </span>
  );
}

function buildListingParams(query) {
  const params = new URLSearchParams();
  const mapping = {
    itemName: "item_name",
    itemType: "itemType",
    pageSize: "page_size",
    rarity: "rarity",
    shiny: "shiny",
    sort: "sort",
    subType: "subType",
    tier: "tier",
    unidentified: "unidentified",
    page: "page",
  };

  Object.entries(mapping).forEach(([stateKey, paramKey]) => {
    const value = query[stateKey];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      params.set(paramKey, String(value).trim());
    }
  });

  return params;
}

function passesLocalPriceFilter(item, query) {
  const min = parseOptionalNumber(query.priceMin);
  const max = parseOptionalNumber(query.priceMax);

  if (min === null && max === null) {
    return true;
  }

  const price = Number(item.listing_price);

  if (!Number.isFinite(price)) {
    return false;
  }

  return passesRange(price, min, max);
}

function evaluateAllGroups(item, groups) {
  const activeGroups = groups.filter((group) => group.enabled);
  const results = activeGroups.map((group) => evaluateGroup(item, group));
  const weightedScores = results
    .map((result) => result.weightedTotal)
    .filter((value) => Number.isFinite(value));

  return {
    activeGroups: activeGroups.length,
    matchedGroups: results.filter((result) => result.passed).length,
    passed: results.every((result) => result.passed),
    weightedTotal: weightedScores.length ? Math.max(...weightedScores) : Number.NaN,
  };
}

function evaluateGroup(item, group) {
  const rows = group.rows.filter((row) => row.stat.trim());

  if (!rows.length) {
    return { passed: true, weightedTotal: Number.NaN };
  }

  const weightedTotal = rows.reduce(
    (total, row) => total + getWeightedContribution(item, row),
    0,
  );

  return {
    passed: rows.every((row) => evaluateWeightedRule(item, row)),
    weightedTotal,
  };
}

function evaluateWeightedRule(item, row) {
  const value = getWeightedStatValue(item, row);

  if (!hasValue(value)) {
    return false;
  }

  const numericValue = Number(value);
  const min = parseOptionalNumber(row.min);
  const max = parseOptionalNumber(row.max);

  return Number.isFinite(numericValue) && passesRange(numericValue, min, max);
}

function getWeightedContribution(item, row) {
  const value = getWeightedStatValue(item, row);

  if (!hasValue(value)) {
    return 0;
  }

  const numericValue = Number(value);
  const weight = parseOptionalNumber(row.weight) ?? 1;

  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  return numericValue * weight;
}

function getWeightedStatValue(item, row) {
  return findStatValue(item.stat_rolls, row.stat);
}

function findStatValue(statRolls, statName) {
  if (!statRolls || !statName.trim()) {
    return null;
  }

  const normalized = normalizeStatName(statName);
  const entry = Object.entries(statRolls).find(
    ([key]) => normalizeStatName(key) === normalized,
  );

  return entry ? entry[1] : null;
}

function sortEvaluatedItems(rows, localSort) {
  const sorted = [...rows];

  if (localSort === "price_asc") {
    sorted.sort((a, b) => Number(a.item.listing_price) - Number(b.item.listing_price));
  }
  if (localSort === "price_desc") {
    sorted.sort((a, b) => Number(b.item.listing_price) - Number(a.item.listing_price));
  }
  if (localSort === "overall_desc") {
    sorted.sort((a, b) => Number(b.item.overall_roll ?? -1) - Number(a.item.overall_roll ?? -1));
  }
  if (localSort === "weighted_desc") {
    sorted.sort((a, b) => safeScore(b.meta.weightedTotal) - safeScore(a.meta.weightedTotal));
  }

  return sorted;
}

function safeScore(value) {
  return Number.isFinite(value) ? value : -Infinity;
}

function passesRange(value, min, max) {
  if (min !== null && value < min) {
    return false;
  }
  if (max !== null && value > max) {
    return false;
  }
  return true;
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function parseOptionalNumber(value) {
  if (value === "" || value === null || value === undefined) {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeStatName(value) {
  return String(value)
    .trim()
    .replace(/[\s_-]+/g, "")
    .toLowerCase();
}

function getListingKey(item) {
  return item.hash_code ?? `${item.name}-${item.playerName}-${item.timestamp}`;
}

function formatEmeralds(value) {
  const emeralds = Number(value);

  if (!Number.isFinite(emeralds)) {
    return "-";
  }

  const le = Math.floor(emeralds / 4096);
  const eb = Math.floor((emeralds % 4096) / 64);
  const e = Math.floor(emeralds % 64);

  if (le > 0) {
    return `${le} LE ${eb} EB`;
  }
  if (eb > 0) {
    return `${eb} EB ${e} E`;
  }
  return `${e} E`;
}

function formatNumber(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "-";
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: number >= 100 ? 0 : 1,
  }).format(number);
}

function formatStatName(value) {
  return String(value)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDate(value) {
  if (!value) {
    return "No timestamp";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString();
}

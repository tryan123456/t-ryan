/**
 * The query controls — one row above the charts, per the interaction spec.
 * Every control writes to the query store; nothing here touches selection.
 */

import { toggleFacet, useQueryStore } from './queryStore'
import { useThemeStore } from '../../shared/theme'
import { CATEGORY_LABEL } from './palette'
import { formatCount } from '../../shared/format'
import { CATEGORIES, REGIONS, STATUSES } from './types'

const LIMITS = [500, 2000, 8000, 20000]

interface Props {
  matched: number
  plotted: number
  total: number
}

export function QueryPanel({ matched, plotted, total }: Props) {
  const query = useQueryStore((state) => state.query)
  const patch = useQueryStore((state) => state.patch)
  const reset = useQueryStore((state) => state.reset)
  const mode = useThemeStore((state) => state.mode)
  const toggleMode = useThemeStore((state) => state.toggle)

  return (
    <div className="query-panel">
      <label className="field field--grow">
        <span className="field__label">Search host</span>
        <input
          type="search"
          className="input"
          placeholder="e.g. eu-central or n-1a"
          value={query.search}
          onChange={(event) => patch({ search: event.target.value })}
        />
      </label>

      <fieldset className="field">
        <legend className="field__label">Category</legend>
        <div className="chips">
          {CATEGORIES.map((category) => (
            <button
              key={category}
              type="button"
              aria-pressed={query.categories.includes(category)}
              className={`chip chip--${category}${
                query.categories.includes(category) ? ' is-on' : ''
              }`}
              onClick={() =>
                patch({ categories: toggleFacet(query.categories, category) })
              }
            >
              <span className="chip__swatch" aria-hidden="true" />
              {CATEGORY_LABEL[category]}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="field">
        <legend className="field__label">Region</legend>
        <div className="chips">
          {REGIONS.map((region) => (
            <button
              key={region}
              type="button"
              aria-pressed={query.regions.includes(region)}
              className={`chip${query.regions.includes(region) ? ' is-on' : ''}`}
              onClick={() => patch({ regions: toggleFacet(query.regions, region) })}
            >
              {region}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="field">
        <legend className="field__label">Status</legend>
        <div className="chips">
          {STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              aria-pressed={query.statuses.includes(status)}
              className={`chip${query.statuses.includes(status) ? ' is-on' : ''}`}
              onClick={() => patch({ statuses: toggleFacet(query.statuses, status) })}
            >
              {status}
            </button>
          ))}
        </div>
      </fieldset>

      <label className="field">
        <span className="field__label">
          Max latency · {query.latencyRange[1]} ms
        </span>
        <input
          type="range"
          className="range"
          min={20}
          max={600}
          step={10}
          value={query.latencyRange[1]}
          onChange={(event) =>
            patch({ latencyRange: [0, Number(event.target.value)] })
          }
        />
      </label>

      <label className="field">
        <span className="field__label">Plot limit</span>
        <select
          className="input"
          value={query.limit}
          onChange={(event) => patch({ limit: Number(event.target.value) })}
        >
          {LIMITS.map((limit) => (
            <option key={limit} value={limit}>
              {formatCount(limit)} points
            </option>
          ))}
        </select>
      </label>

      <div className="query-panel__meta">
        <p className="query-panel__count">
          <strong>{formatCount(plotted)}</strong> plotted ·{' '}
          {formatCount(matched)} matched of {formatCount(total)}
        </p>
        <div className="query-panel__actions">
          <button type="button" className="button" onClick={reset}>
            Reset query
          </button>
          <button type="button" className="button" onClick={toggleMode}>
            {mode === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
        </div>
      </div>
    </div>
  )
}

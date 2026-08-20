/**
 * The raw-data table.
 *
 * Renders the same rows the charts plot, in the same order the charts index
 * them, and reads selection from the same store. It owns exactly one piece of
 * state of its own — the sort — and even that is exported upward as
 * `orderedIds`, because shift-range must follow what the user sees, not the
 * underlying dataset order.
 *
 * Virtualised, because the query can return tens of thousands of rows.
 */

import { useEffect, useMemo, useRef, type PointerEvent } from 'react'
import {
  columnSizingFeature,
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  expandRange,
  modifiersOf,
  resolveListOp,
  useSelectionStore,
} from '../selection'
import { CATEGORY_LABEL } from './palette'
import { formatDate, formatValue } from '../../shared/format'
import type { DataPoint } from './types'

const ROW_HEIGHT = 34
const NO_IDS: readonly string[] = []

function sameOrder(a: readonly string[], b: readonly string[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * v9 gates feature APIs on registration, so this list is the table's whole
 * capability surface. Row selection is deliberately absent — `useSelectionStore`
 * owns that, and a second copy inside the table would only need reconciling.
 */
const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  columnSizingFeature,
})

const helper = createColumnHelper<typeof features, DataPoint>()

/**
 * Subscribes to a single id so a selection change repaints only the checkbox
 * that actually changed, not the whole virtual window.
 */
function RowCheckbox({ id }: { id: string }) {
  const checked = useSelectionStore((state) => state.ids.has(id))
  const apply = useSelectionStore((state) => state.apply)

  return (
    <input
      type="checkbox"
      className="cell-check"
      checked={checked}
      aria-label={`Select ${id}`}
      // The row handler runs on pointerdown; stopping propagation here keeps a
      // checkbox click a pure toggle rather than a toggle plus a row-replace.
      onPointerDown={(event) => event.stopPropagation()}
      onChange={() => apply([id], 'toggle', { anchorId: id, source: 'table' })}
    />
  )
}

const numeric = (unit: string) => ({
  cell: (info: { getValue: () => number }) => formatValue(info.getValue(), unit),
  meta: { align: 'right' as const },
})

const columns = helper.columns([
  helper.display({
    id: 'select',
    header: () => <span aria-label="Selected">✓</span>,
    size: 40,
    cell: ({ row }) => <RowCheckbox id={row.original.id} />,
  }),
  helper.accessor('name', { header: 'Host', size: 200 }),
  helper.accessor('category', {
    header: 'Category',
    size: 110,
    cell: (info) => (
      <span className={`tag tag--${info.getValue()}`}>
        {CATEGORY_LABEL[info.getValue()]}
      </span>
    ),
  }),
  helper.accessor('region', { header: 'Region', size: 110 }),
  helper.accessor('status', {
    header: 'Status',
    size: 100,
    cell: (info) => (
      <span className={`status status--${info.getValue()}`}>{info.getValue()}</span>
    ),
  }),
  helper.accessor('latencyMs', { header: 'Latency', size: 100, ...numeric(' ms') }),
  helper.accessor('throughputRps', {
    header: 'Throughput',
    size: 120,
    ...numeric(' rps'),
  }),
  helper.accessor('cpuPct', { header: 'CPU', size: 90, ...numeric('%') }),
  helper.accessor('memoryPct', { header: 'Memory', size: 100, ...numeric('%') }),
  helper.accessor('errorRatePct', { header: 'Errors', size: 90, ...numeric('%') }),
  helper.accessor('timestamp', {
    header: 'Sampled',
    size: 110,
    cell: (info) => formatDate(info.getValue()),
  }),
])

interface Props {
  rows: readonly DataPoint[]
  /** Lifted so hotkeys and the toolbar act on the order the user sees. */
  onOrderChange: (orderedIds: string[]) => void
}

export function DataTable({ rows, onOrderChange }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const selectedIds = useSelectionStore((state) => state.ids)
  const revision = useSelectionStore((state) => state.revision)
  const source = useSelectionStore((state) => state.source)

  // The pipeline hands rows out read-only; the table wants a mutable array but
  // never writes to it. Cast rather than copy — this can be 20k rows.
  const data = useMemo(() => rows as DataPoint[], [rows])

  const table = useTable({
    features,
    columns,
    data,
    getRowId: (row) => row.id,
  })

  const modelRows = table.getRowModel().rows
  // Keyed on what actually changes the order, not on the row-model's identity:
  // deriving it from `modelRows` would produce a fresh array every render and
  // the notify-upward effect below would loop.
  const sorting = table.state.sorting
  const orderedIds = useMemo(
    () => table.getRowModel().rows.map((row) => row.original.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, sorting],
  )

  // Notifying the parent feeds state back down as props, so this only fires on
  // a genuine order change. The content check is the loop-breaker: if the memo
  // above ever recomputed on identity alone, this would stop it dead.
  const lastReported = useRef<readonly string[]>(NO_IDS)
  useEffect(() => {
    if (sameOrder(lastReported.current, orderedIds)) return
    lastReported.current = orderedIds
    onOrderChange(orderedIds)
  }, [orderedIds, onOrderChange])

  const virtualizer = useVirtualizer({
    count: modelRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => modelRows[index].id,
    overscan: 12,
  })

  const gridTemplate = useMemo(
    () =>
      table
        .getAllFlatColumns()
        .map((column) => `${column.getSize()}px`)
        .join(' '),
    [table],
  )

  // Follow the selection when it came from somewhere else. Scrolling on the
  // table's own clicks would yank the list out from under the pointer.
  const scrollToIndex = virtualizer.scrollToIndex
  useEffect(() => {
    if (source === 'table' || selectedIds.size === 0) return
    const index = orderedIds.findIndex((id) => selectedIds.has(id))
    if (index >= 0) scrollToIndex(index, { align: 'center' })
    // `revision` is the change signal; the rest are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  const handleRowPointerDown = (
    event: PointerEvent<HTMLDivElement>,
    id: string,
  ) => {
    if (event.button !== 0) return
    const modifiers = modifiersOf(event)
    const op = resolveListOp(modifiers)
    const { anchorId, apply } = useSelectionStore.getState()

    if (op === 'range') {
      const range = expandRange(orderedIds, anchorId, id)
      // Plain shift replaces the selection with the range; adding ctrl/cmd
      // unions it with what was already there — standard list-view behaviour.
      const rangeOp = modifiers.ctrlKey || modifiers.metaKey ? 'add' : 'replace'
      apply(range, rangeOp, { source: 'table' })
      return
    }

    apply([id], op, { anchorId: id, source: 'table' })
  }

  return (
    <section className="table-card">
      <div ref={scrollRef} className="table-card__scroll">
        <div className="table">
          <div className="table__head" role="rowgroup">
            {table.getHeaderGroups().map((group) => (
              <div
                key={group.id}
                className="table__row table__row--head"
                style={{ gridTemplateColumns: gridTemplate }}
                role="row"
              >
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted()
                  return (
                    <div
                      key={header.id}
                      role="columnheader"
                      aria-sort={
                        sorted === 'asc'
                          ? 'ascending'
                          : sorted === 'desc'
                            ? 'descending'
                            : 'none'
                      }
                      className={`table__cell table__cell--head${
                        header.column.getCanSort() ? ' is-sortable' : ''
                      }`}
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      {header.isPlaceholder ? null : (
                        <table.FlexRender header={header} />
                      )}
                      {sorted ? (
                        <span className="sort-mark">
                          {sorted === 'asc' ? '↑' : '↓'}
                        </span>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>

          <div
            className="table__body"
            role="rowgroup"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = modelRows[item.index]
              const isSelected = selectedIds.has(row.original.id)
              return (
                <div
                  key={row.id}
                  data-index={item.index}
                  role="row"
                  aria-selected={isSelected}
                  className={`table__row${isSelected ? ' is-selected' : ''}`}
                  style={{
                    gridTemplateColumns: gridTemplate,
                    height: ROW_HEIGHT,
                    transform: `translateY(${item.start}px)`,
                  }}
                  onPointerDown={(event) =>
                    handleRowPointerDown(event, row.original.id)
                  }
                >
                  {row.getAllCells().map((cell) => (
                    <div
                      key={cell.id}
                      role="cell"
                      className={`table__cell${
                        (cell.column.columnDef.meta as { align?: string })?.align ===
                        'right'
                          ? ' table__cell--num'
                          : ''
                      }`}
                    >
                      <table.FlexRender cell={cell} />
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {modelRows.length === 0 ? (
        <p className="table-card__empty">No rows match the current query.</p>
      ) : null}
    </section>
  )
}

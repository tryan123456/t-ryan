/**
 * One legend for both charts — they share an encoding, so duplicating it would
 * just be noise. Rendered in HTML rather than on the canvas so the labels wear
 * text tokens instead of the series colour.
 *
 * The category entries double as filters; the trend entry is a mark key only,
 * since the trend line is an annotation rather than a category.
 */

import { toggleFacet, useQueryStore } from './queryStore'
import { CATEGORY_LABEL } from './palette'
import { CATEGORIES } from './types'

export function Legend() {
  const categories = useQueryStore((state) => state.query.categories)
  const patch = useQueryStore((state) => state.patch)

  return (
    <div className="legend" role="group" aria-label="Series legend and filter">
      {CATEGORIES.map((category) => {
        const on = categories.includes(category)
        return (
          <button
            key={category}
            type="button"
            aria-pressed={on}
            className={`legend__item legend__item--${category}${on ? '' : ' is-off'}`}
            onClick={() => patch({ categories: toggleFacet(categories, category) })}
          >
            <span className="legend__dot" aria-hidden="true" />
            {CATEGORY_LABEL[category]}
          </button>
        )
      })}
      <span className="legend__item legend__item--static">
        <span className="legend__line" aria-hidden="true" />
        Trend (binned mean)
      </span>
    </div>
  )
}

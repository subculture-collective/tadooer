/**
 * Identity panel for the signed-out screens (sign-in and first-run setup).
 * The mark, wordmark, line and planner-day motif follow the Studio brand pack
 * and docs/design/README.md. The planner day is decorative: its row titles are
 * placeholders, so it is hidden from assistive technology.
 */
export function AuthBrand() {
  return (
    <header className="auth-brand">
      <p className="auth-brand-lockup">
        <svg
          className="auth-brand-mark"
          viewBox="0 0 512 512"
          aria-hidden="true"
          focusable="false"
        >
          <rect
            x="3"
            y="3"
            width="506"
            height="506"
            rx="109"
            className="auth-brand-tile"
          />
          <path
            d="M132 154h248v44H132zm0 80h170v44H132zm0 80h248v44H132z"
            className="auth-brand-lines"
          />
          <circle cx="350" cy="256" r="54" className="auth-brand-disc" />
          <path d="m327 256 16 17 33-39" className="auth-brand-check" />
        </svg>
        <span className="auth-brand-name">Tadooer</span>
      </p>
      <h1>The plan, and the one thing now.</h1>
      <p className="auth-brand-about">
        Tadooer is a task and calendar planner for one owner.
      </p>
      <p className="auth-brand-about">
        This instance is private and self-hosted. There is no sign-up.
      </p>
      <svg
        className="auth-brand-day"
        viewBox="0 0 540 264"
        aria-hidden="true"
        focusable="false"
      >
        <g className="day-hours">
          <text x="0" y="17">
            09:00
          </text>
          <text x="0" y="99">
            10:00
          </text>
          <text x="0" y="181">
            11:00
          </text>
          <text x="0" y="263">
            12:00
          </text>
        </g>
        <path
          className="day-rule"
          d="M87 11.5H540M87 93.5H540M87 175.5H540M87 257.5H540"
        />
        <rect
          className="day-row day-row-focus"
          x="88"
          y="18"
          width="451"
          height="46"
          rx="8"
        />
        <rect
          className="day-row"
          x="88"
          y="70"
          width="451"
          height="46"
          rx="8"
        />
        <rect
          className="day-row"
          x="88"
          y="123"
          width="451"
          height="46"
          rx="8"
        />
        <g className="day-box">
          <rect x="101" y="32.5" width="17" height="17" rx="4" />
          <rect x="101" y="84.5" width="17" height="17" rx="4" />
          <rect x="101" y="137.5" width="17" height="17" rx="4" />
        </g>
        <g className="day-title">
          <text x="132" y="48">
            Write the release notes
          </text>
          <text x="132" y="100">
            Plan Thursday
          </text>
          <text x="132" y="153">
            Review the week
          </text>
        </g>
        <g className="day-meta">
          <text className="day-now-text" x="526" y="46.5">
            25m · 10:00
          </text>
          <text x="526" y="98.5">
            Today
          </text>
          <text x="526" y="151.5">
            15m
          </text>
        </g>
        <rect
          className="day-calendar"
          x="87"
          y="181"
          width="453"
          height="70"
          rx="8"
        />
        <rect
          className="day-calendar-edge"
          x="87"
          y="181"
          width="3"
          height="70"
        />
        <text className="day-calendar-text" x="101" y="222">
          Calendar · 11:00–12:00
        </text>
        <path className="day-now" d="M81 120.5H540" />
        <circle className="day-now-dot" cx="81" cy="120.5" r="4.5" />
      </svg>
    </header>
  );
}

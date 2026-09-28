const TERM_START = "2026-08-29";
const TERM_END = "2026-11-29";
const CACHE_KEY = "attendwise.sections.v1";
const SECTION_DATA_CACHE_KEY = "attendwise.section-counts.v1";
const SNAPSHOT_KEY = "attendwise.snapshot.v1";
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
let SECTION_DATA = [];

const state = { sectionId: null, snapshot: null, manualSection: null, manualCalculation: null, manualEffective: null, demo: false, chart: null, online: navigator.onLine };
const $ = (selector) => document.querySelector(selector);

function localISODate(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function statusFor(attended, conducted) {
  if (conducted === 0) return "UNSTARTED";
  if (attended * 10 >= conducted * 9) return "SAFE";
  if (attended * 4 >= conducted * 3) return "WARNING";
  return "CRITICAL";
}

function recoveryFor(attended, conducted, target) {
  const deficit = target === 90
    ? 9 * conducted - 10 * attended
    : 3 * conducted - 4 * attended;
  return Math.max(0, deficit);
}

function safeSkipsFor(attended, conducted, target) {
  if (!conducted) return 0;
  const currentIsSafe = target === 90
    ? attended * 10 >= conducted * 9
    : attended * 4 >= conducted * 3;
  if (!currentIsSafe) return 0;
  const numerator = target === 90
    ? 10 * attended - 9 * conducted
    : 4 * attended - 3 * conducted;
  return Math.max(0, Math.floor(numerator / (target === 90 ? 9 : 3)));
}

function percentage(attended, conducted) {
  return conducted ? attended * 100 / conducted : null;
}

function projection(attended, conducted, futureAttended, futureMissed) {
  const total = conducted + futureAttended + futureMissed;
  return total ? (attended + futureAttended) * 100 / total : null;
}

function countFromCalendar(snapshot, subjectId, until, fromDate = null) {
  const calendar = snapshot.calendar;
  if (!calendar) return 0;
  const rangeStart = fromDate || calendar.today;
  const startDate = rangeStart > snapshot.semester.start_date
    ? rangeStart
    : snapshot.semester.start_date;
  if (startDate > until) return 0;
  const recorded = new Set(calendar.recorded.map(([id, date, slot]) => `${id}|${date}|${slot}`));
  let total = 0;
  const cursor = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${until}T12:00:00`);
  while (cursor <= end) {
    const isoDate = localISODate(cursor);
    const weekday = (cursor.getDay() + 6) % 7;
    for (const entry of calendar.entries) {
      if (entry.is_break || !entry.subject_id || Number(entry.subject_id) !== Number(subjectId) || entry.weekday !== weekday) continue;
      const exceptions = calendar.exceptions.filter((item) => item.exception_date === isoDate);
      const holiday = exceptions.some((item) => item.kind === "holiday" && (item.subject_id === null || Number(item.subject_id) === Number(subjectId)));
      const cancelled = exceptions.some((item) => item.kind === "cancelled" && (item.subject_id === null || Number(item.subject_id) === Number(subjectId)) && (!item.slot || item.slot === entry.slot));
      if (!holiday && !cancelled && !recorded.has(`${subjectId}|${isoDate}|${entry.slot}`)) total += Number(entry.units) || 1;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  for (const item of calendar.exceptions) {
    if (item.kind !== "makeup" || Number(item.subject_id) !== Number(subjectId) || item.exception_date < startDate || item.exception_date > until) continue;
    if (!recorded.has(`${subjectId}|${item.exception_date}|${item.slot}`)) total += Number(item.units) || 1;
  }
  return total;
}

function countDemoThrough(subject, planningDate) {
  return subject.demoDates.filter((day) => day >= localISODate() && day <= planningDate).length;
}

function countDemoRange(subject, startDate, endDate) {
  return subject.demoDates.filter((day) => day >= startDate && day <= endDate && day >= localISODate()).length;
}

function shiftISODate(value, days) {
  const result = new Date(`${value}T12:00:00`);
  result.setDate(result.getDate() + days);
  return localISODate(result);
}

function countWeekdaySessions(startDate, endDate) {
  if (startDate > endDate) return 0;
  let total = 0;
  const cursor = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  while (cursor <= end) {
    if (cursor.getDay() >= 1 && cursor.getDay() <= 5) total += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return total;
}

function countSectionClasses(section, startDate, endDate) {
  if (startDate > endDate) return 0;
  const weekdays = countWeekdaySessions(startDate, endDate);
    return Math.round(section.weekly_classes * weekdays / 5);
}

function normalizeSubject(subject) {
  const attended = Number(subject.attended) || 0;
  const conducted = Number(subject.conducted) || 0;
  const scheduleVerified = state.demo || state.snapshot.section.schedule_verified === true;
  const termEnd = state.snapshot.semester.end_date || TERM_END;
  const remaining = !scheduleVerified ? null : state.demo
    ? countDemoThrough(subject, termEnd)
    : state.snapshot.calendar
      ? countFromCalendar(state.snapshot, subject.id, termEnd)
      : Number(subject.remaining) || 0;
  const planningRemaining = !scheduleVerified ? null : state.demo
    ? countDemoThrough(subject, $("#planning-date").value)
    : state.snapshot.calendar
      ? countFromCalendar(state.snapshot, subject.id, $("#planning-date").value)
      : Number(subject.classes_by_planning_date ?? remaining) || 0;
  const pct = percentage(attended, conducted);
  const status = statusFor(attended, conducted);
  const need75 = recoveryFor(attended, conducted, 75);
  const need90 = recoveryFor(attended, conducted, 90);
  return { ...subject, attended, conducted, remaining, planningRemaining, pct, status, need75, need90 };
}

function demoSchedule(weekdays) {
  const dates = [];
  const start = new Date(`${localISODate()}T12:00:00`);
  start.setDate(start.getDate() + 1);
  const end = new Date(`${TERM_END}T12:00:00`);
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    if (weekdays.includes(cursor.getDay())) dates.push(localISODate(cursor));
  }
  return dates;
}

function makeDemo() {
  const subjects = [
    { id: "demo-signal", subject_code: "DEMO-201", name: "Biomedical Signals", attended: 9, conducted: 10, remaining: 0, demoDates: demoSchedule([1, 3]) },
    { id: "demo-electromagnetics", subject_code: "DEMO-202", name: "Electromagnetic Theory", attended: 8, conducted: 10, remaining: 0, demoDates: demoSchedule([2, 4]) },
    { id: "demo-logic", subject_code: "DEMO-203", name: "Digital Logic Systems", attended: 2, conducted: 15, remaining: 0, demoDates: demoSchedule([1, 3, 5]) },
  ];
  for (const subject of subjects) subject.remaining = subject.demoDates.length;
  return {
    section: { id: "demo", name: "Synthetic example section", academic_year: "2026-27", schedule_verified: true },
    semester: { start_date: TERM_START, end_date: TERM_END },
    subjects,
  };
}

function setConnection(online, text) {
  const element = $("#connection-state");
  element.classList.toggle("online", online);
  element.classList.toggle("offline", !online);
  element.querySelector("span:last-child").textContent = text;
  $("#offline-label").textContent = online
    ? "Calculations run in your browser when offline."
    : "Offline · calculations are running locally.";
}

function showAdvisor(subjects) {
  const advisor = $("#advisor p");
  if (!state.demo && state.snapshot.section.schedule_verified !== true) {
    advisor.textContent = "Attendance percentages and threshold math are available. Verify this section’s timetable before using class counts or detention feasibility.";
    return;
  }
  const critical = subjects.filter((subject) => subject.status === "CRITICAL");
  const unreachable = critical.filter((subject) => subject.need75 > subject.remaining);
  if (unreachable.length) {
    advisor.textContent = `${unreachable.map((subject) => subject.name).join(", ")} cannot reach 75% by Nov 29, even with attendance at every remaining class.`;
    return;
  }
  if (critical.length) {
    const subject = critical[0];
    advisor.textContent = `${subject.name} needs ${subject.need75} consecutive attended classes to reach 75%; ${subject.remaining} are scheduled through semester end.`;
    return;
  }
  const warning = subjects.find((subject) => subject.status === "WARNING");
  if (warning) {
    advisor.textContent = `${warning.name} is above 75%. Attend ${warning.need90} classes in a row to reach 90%; ${warning.remaining} classes remain this semester.`;
    return;
  }
  advisor.textContent = subjects.length
    ? "All loaded subjects are at or above 90%. Check each subject’s safe skips before missing a class."
    : "No subjects are available for this section yet.";
}

function updateChart(subjects) {
  const counts = [
    subjects.filter((item) => item.status === "SAFE").length,
    subjects.filter((item) => item.status === "WARNING").length,
    subjects.filter((item) => item.status === "CRITICAL").length,
  ];
  const canvas = $("#risk-chart");
  const fallback = $("#chart-fallback");
  if (window.Chart) {
    fallback.hidden = true;
    canvas.hidden = false;
    if (state.chart) state.chart.destroy();
    state.chart = new Chart(canvas, {
      type: "doughnut",
      data: { labels: ["Safe", "Warning", "Critical"], datasets: [{ data: counts, backgroundColor: ["#176c53", "#d39229", "#c64b45"], borderWidth: 0, hoverOffset: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: "72%", plugins: { legend: { display: false }, tooltip: { enabled: true } } },
    });
    return;
  }
  canvas.hidden = true;
  fallback.hidden = false;
  const labels = ["Safe", "Warning", "Critical"];
  const colors = ["#176c53", "#d39229", "#c64b45"];
  fallback.innerHTML = labels.map((label, index) => `<div class="fallback-line"><span>${label}</span><span class="fallback-track"><i style="width:${subjects.length ? counts[index] / subjects.length * 100 : 0}%;background:${colors[index]}"></i></span><b>${counts[index]}</b></div>`).join("");
}

function subjectHTML(subject) {
  const scheduleVerified = subject.remaining !== null;
  const pctText = subject.pct === null ? "Not started" : `${subject.pct.toFixed(1)}%`;
  const statusClass = subject.status.toLowerCase();
  const statusLabel = subject.status === "UNSTARTED" ? "UNSTARTED" : subject.status;
  const plan75 = subject.planningRemaining;
  const planFeasible75 = scheduleVerified && subject.need75 <= plan75;
  const planFeasible90 = scheduleVerified && subject.need90 <= plan75;
  const resultText = !scheduleVerified
    ? `<strong>${subject.need75 || subject.need90}</strong> consecutive classes needed; verify the timetable for feasibility`
    : subject.status === "CRITICAL"
    ? `<strong>${subject.need75}</strong> to reach 75%${planFeasible75 ? ` by ${formatDate($("#planning-date").value)}` : `; only ${plan75} by selected date`}`
    : subject.need90 === 0
      ? `<strong>At 90%</strong> now; ${safeSkipsFor(subject.attended, subject.conducted, 90)} safe misses`
      : `<strong>${subject.need90}</strong> consecutive to reach 90%${planFeasible90 ? " by selected date" : "; not possible by selected date"}`;
  return `<article class="subject-row" data-subject="${subject.id}">
    <div class="subject-top"><div class="subject-name"><strong>${escapeHTML(subject.name)}</strong><span class="subject-code">${escapeHTML(subject.subject_code || "")}</span></div><span class="risk-pill ${statusClass}">${statusLabel}</span></div>
    <div class="attendance-line"><div class="progress-track"><div class="progress-value ${statusClass}" style="width:${subject.pct === null ? 0 : Math.max(0, Math.min(100, subject.pct))}%"></div></div><span class="percent-value">${pctText}</span><span class="row-stat"><b>${subject.attended}/${subject.conducted}</b>attended</span><span class="row-stat"><b>${scheduleVerified ? subject.remaining : "—"}</b>left in term</span></div>
    <div class="row-controls">
      <label class="mini-field">Attended<input class="attended-input" type="number" min="0" step="1" value="${subject.attended}" aria-label="Attended classes for ${escapeHTML(subject.name)}"></label>
      <label class="mini-field">Conducted<input class="conducted-input" type="number" min="0" step="1" value="${subject.conducted}" aria-label="Conducted classes for ${escapeHTML(subject.name)}"></label>
      <button class="action-button save-attendance" type="button">Save totals</button>
      <span class="row-result">${resultText}</span>
      <label class="mini-field">Attend<input class="future-attended" type="number" min="0" step="1" value="0" ${scheduleVerified ? "" : "disabled"} aria-label="Future classes to attend for ${escapeHTML(subject.name)}"></label>
      <label class="mini-field">Miss<input class="future-missed" type="number" min="0" step="1" value="0" ${scheduleVerified ? "" : "disabled"} aria-label="Future classes to miss for ${escapeHTML(subject.name)}"></label>
      <button class="action-button simulate-subject" type="button" ${scheduleVerified ? "" : "disabled"}>What if?</button>
      <span class="simulation-result" aria-live="polite"></span>
    </div>
  </article>`;
}

function render(snapshot) {
  state.snapshot = snapshot;
  const subjects = snapshot.subjects.map(normalizeSubject);
  const isDemo = state.demo;
  const scheduleVerified = isDemo || snapshot.section.schedule_verified === true;
  $("#dashboard").hidden = false;
  $("#empty-state").hidden = true;
  $("#section-title").textContent = snapshot.section.name;
  $("#planning-caption").textContent = `Through ${formatDate($("#planning-date").value)}`;
  $("#subjects-list").innerHTML = subjects.length ? subjects.map(subjectHTML).join("") : '<p class="calculation-note">No subjects imported for this section yet.</p>';

  const totalRemaining = subjects.reduce((sum, subject) => sum + subject.remaining, 0);
  const totalAttended = subjects.reduce((sum, subject) => sum + subject.attended, 0);
  const totalConducted = subjects.reduce((sum, subject) => sum + subject.conducted, 0);
  const overall = percentage(totalAttended, totalConducted);
  $("#overall-percent").textContent = overall === null ? "—" : `${overall.toFixed(1)}%`;
  $("#overall-bar").style.width = `${overall === null ? 0 : Math.max(0, Math.min(100, overall))}%`;
  $("#overall-bar").className = statusFor(totalAttended, totalConducted).toLowerCase();
  $("#overall-counts").textContent = overall === null
    ? "No class units conducted yet"
    : `${totalAttended} attended / ${totalConducted} conducted units`;
  const need75 = subjects.reduce((sum, subject) => sum + subject.need75, 0);
  const need90 = subjects.reduce((sum, subject) => sum + subject.need90, 0);
  const riskCount = subjects.filter((subject) => subject.status !== "SAFE" && subject.status !== "UNSTARTED").length;
  $("#sum-remaining").textContent = scheduleVerified ? String(totalRemaining) : "—";
  $("#sum-75").textContent = String(need75);
  $("#sum-90").textContent = String(need90);
  $("#sum-risk").textContent = String(riskCount);
  showAdvisor(subjects);
  updateChart(subjects);

  const unreachable = scheduleVerified
    ? subjects.filter((subject) => subject.status !== "UNSTARTED" && subject.need75 > subject.remaining)
    : [];
  const alert = $("#detention-alert");
  alert.hidden = unreachable.length === 0;
  if (unreachable.length) {
    $("#detention-copy").textContent = `${unreachable.map((subject) => `${subject.name} (${subject.need75} needed, ${subject.remaining} left)`).join("; ")} cannot reach 75% by Nov 29, 2026, even if every remaining class is attended.`;
  }

  const note = $("#source-note");
  note.hidden = !isDemo && scheduleVerified;
  note.textContent = isDemo
    ? "SYNTHETIC DEMO · Example subjects and weekly schedules only. These are not extracted from your timetable PDFs."
    : scheduleVerified ? "" : "TIMETABLE NOT VERIFIED · Attendance math is available, but remaining classes and detention feasibility are withheld.";
  bindSubjectActions(subjects);
  bindLeaveControls(subjects, scheduleVerified);
}

function bindLeaveControls(subjects, scheduleVerified) {
  const select = $("#leave-subject");
  select.innerHTML = subjects.map((subject) => `<option value="${subject.id}">${escapeHTML(subject.name)}</option>`).join("");
  const startInput = $("#leave-start");
  const tomorrow = shiftISODate(localISODate(), 1);
  startInput.min = tomorrow;
  startInput.max = state.snapshot.semester.end_date;
  if (!startInput.value || startInput.value < tomorrow) startInput.value = tomorrow;

  const calculate = () => {
    const output = $("#leave-result");
    output.className = "leave-result";
    if (!scheduleVerified) {
      output.textContent = "Verify this section's timetable to calculate affected class units.";
      return;
    }
    const subject = subjects.find((item) => String(item.id) === select.value);
    const days = Number($("#leave-days").value);
    const startDate = startInput.value;
    if (!subject || !Number.isInteger(days) || days < 1 || !startDate) {
      output.textContent = "Choose a subject, start date, and positive whole number of days.";
      return;
    }
    const endDate = shiftISODate(startDate, days - 1);
    if (startDate < tomorrow || endDate > state.snapshot.semester.end_date) {
      output.textContent = "Leave dates must be after today and within the semester.";
      return;
    }
    const units = state.demo
      ? countDemoRange(subject, startDate, endDate)
      : countFromCalendar(state.snapshot, subject.id, endDate, startDate);
    const affected = Math.min(subject.remaining, units);
    const isMedical = $("#leave-type").value === "medical";
    const futureAttended = isMedical ? subject.remaining - affected : subject.remaining;
    const futureMissed = isMedical ? affected : 0;
    const result = projection(subject.attended, subject.conducted, futureAttended, futureMissed);
    const category = statusFor(subject.attended + futureAttended, subject.conducted + futureAttended + futureMissed);
    output.classList.add(category.toLowerCase());
    const typeLabel = isMedical ? "medical leave (missed)" : "OD (attended)";
    output.textContent = `${formatDate(startDate)}–${formatDate(endDate)}: ${affected} scheduled class unit${affected === 1 ? "" : "s"} affected. ${typeLabel}; projected semester-end ${result === null ? "not started" : `${result.toFixed(1)}%`}. Assumes all other remaining classes are attended.`;
  };
  for (const element of [select, $("#leave-type"), startInput, $("#leave-days")]) {
    element.oninput = calculate;
    element.onchange = calculate;
  }
  calculate();
}

function bindSubjectActions(subjects) {
  document.querySelectorAll(".subject-row").forEach((row) => {
    const subject = subjects.find((item) => String(item.id) === row.dataset.subject);
    if (!subject) return;
    const attendedInput = row.querySelector(".attended-input");
    const conductedInput = row.querySelector(".conducted-input");
    const pct = row.querySelector(".percent-value");
    const status = row.querySelector(".risk-pill");
    const progress = row.querySelector(".progress-value");
    const updatePreview = () => {
      const attended = Number(attendedInput.value);
      const conducted = Number(conductedInput.value);
      if (!Number.isInteger(attended) || !Number.isInteger(conducted) || attended < 0 || conducted < attended) {
        pct.textContent = "Check A/C";
        return;
      }
      const value = percentage(attended, conducted);
      const currentStatus = statusFor(attended, conducted);
      pct.textContent = value === null ? "Not started" : `${value.toFixed(1)}%`;
      status.textContent = currentStatus;
      status.className = `risk-pill ${currentStatus.toLowerCase()}`;
      progress.className = `progress-value ${currentStatus.toLowerCase()}`;
      progress.style.width = `${value === null ? 0 : Math.max(0, Math.min(100, value))}%`;
    };
    attendedInput.addEventListener("input", updatePreview);
    conductedInput.addEventListener("input", updatePreview);
    row.querySelector(".save-attendance").addEventListener("click", async () => {
      const attended = Number(attendedInput.value);
      const conducted = Number(conductedInput.value);
      const result = row.querySelector(".row-result");
      if (!Number.isInteger(attended) || !Number.isInteger(conducted) || attended < 0 || conducted < attended) {
        result.textContent = "Enter whole counts with attended ≤ conducted.";
        return;
      }
      if (state.demo) {
        subject.attended = attended;
        subject.conducted = conducted;
        render(state.snapshot);
        return;
      }
      try {
        const response = await fetch("/api/attendance/summary", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject_id: subject.id, attended, conducted }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not save attendance totals.");
        await loadSection(state.sectionId, false);
      } catch (error) {
        result.textContent = error.message;
      }
    });
    row.querySelector(".simulate-subject").addEventListener("click", () => {
      const futureAttended = Number(row.querySelector(".future-attended").value);
      const futureMissed = Number(row.querySelector(".future-missed").value);
      const output = row.querySelector(".simulation-result");
      if (subject.planningRemaining === null) {
        output.textContent = "Verify the timetable to simulate future classes.";
        return;
      }
      if (![futureAttended, futureMissed].every(Number.isInteger) || futureAttended < 0 || futureMissed < 0 || futureAttended + futureMissed > subject.planningRemaining) {
        output.textContent = `Use whole numbers totaling ≤${subject.planningRemaining} by the selected date.`;
        return;
      }
      const value = projection(subject.attended, subject.conducted, futureAttended, futureMissed);
      output.textContent = value === null ? "No classes counted yet." : `Projected ${value.toFixed(1)}%`;
    });
  });
}

function advisorReply(question) {
  if (state.manualSection) return manualAdvisorReply(question);
  if (!state.snapshot) return "Choose a section or open the synthetic demo first so I can read attendance data.";
  const source = state.snapshot.subjects.map(normalizeSubject);
  const text = question.toLowerCase();
  const matches = source.filter((subject) => text.includes(subject.name.toLowerCase()) || (subject.subject_code && text.includes(subject.subject_code.toLowerCase())));
  const subject = matches[0] || (source.length === 1 ? source[0] : null);
  if (!subject) return `Which subject do you mean? I can see: ${source.map((item) => item.name).join(", ") || "no subjects in this section"}.`;

  const isLeaveQuestion = /leave|sick|medical|on[- ]duty|\bod\b|absence/.test(text);
  if (isLeaveQuestion) {
    if (subject.remaining === null) return `I can calculate ${subject.name}'s current attendance, but leave impact needs a verified timetable. The schedule is not verified yet.`;
    const dayMatch = text.match(/\b(\d+)\s*[- ]?\s*(?:calendar\s*)?days?\b/) || text.match(/\b(\d+)\s*(?:classes|sessions?)\b/);
    if (!dayMatch) return "How many calendar days should I model? For example: 3-day medical leave starting tomorrow.";
    const startDate = /tomorrow/.test(text)
      ? shiftISODate(localISODate(), 1)
      : (text.match(/\b20\d{2}-\d{2}-\d{2}\b/) || [])[0]
        || (/\btoday\b/.test(text) ? localISODate() : null);
    if (!startDate) return "What date does the leave start? Say 'tomorrow' or use YYYY-MM-DD.";
    const days = Number(dayMatch[1]);
    const endDate = shiftISODate(startDate, days - 1);
    if (days < 1 || endDate > state.snapshot.semester.end_date) return "That leave range is outside this semester; please choose dates through Nov 29, 2026.";
    const leaveUnits = Math.min(subject.remaining, state.demo
      ? countDemoRange(subject, startDate, endDate)
      : countFromCalendar(state.snapshot, subject.id, endDate, startDate));
    const isOD = /on[- ]duty|\bod\b/.test(text);
    const futureMissed = isOD ? 0 : leaveUnits;
    const futureAttended = subject.remaining - futureMissed;
    const projected = projection(subject.attended, subject.conducted, futureAttended, futureMissed);
    const finalAttended = subject.attended + futureAttended;
    const finalConducted = subject.conducted + futureAttended + futureMissed;
    const threshold = /90\s*%|ninety/.test(text) ? 90 : 75;
    const below = threshold === 90
      ? finalAttended * 10 < finalConducted * 9
      : finalAttended * 4 < finalConducted * 3;
    const type = isOD ? "OD counted as attended" : "medical leave counted as missed";
    return `${subject.name}: ${days} calendar day${days === 1 ? "" : "s"} (${formatDate(startDate)}–${formatDate(endDate)}) contain ${leaveUnits} scheduled class unit${leaveUnits === 1 ? "" : "s"}. ${type}. If you attend all other ${subject.remaining - leaveUnits} remaining units, projected semester-end attendance is ${projected === null ? "not started" : `${projected.toFixed(1)}%`}. This ${below ? `falls below` : `stays at or above`} ${threshold}%.`;
  }

  const pct = subject.pct === null ? "not started" : `${subject.pct.toFixed(1)}%`;
  const base = `${subject.name} is at ${pct} (${subject.attended}/${subject.conducted} units). It takes ${subject.need75} consecutive attended units to reach 75% and ${subject.need90} to reach 90%.`;
  if (subject.remaining === null) return `${base} Verify the timetable before relying on remaining-class or end-of-term feasibility.`;
  return `${base} ${subject.remaining} scheduled units remain. ${subject.need75 > subject.remaining ? "75% is mathematically unreachable by semester end, even if you attend every remaining class." : `75% is still reachable by attending at least ${subject.need75} future units.`}`;
}

function manualAdvisorReply(question) {
  const current = state.manualEffective || state.manualCalculation;
  if (!current) return "Enter your current attendance percentage and calculate first; then I can use the selected section's data.";
  const text = question.toLowerCase();
  if (/leave|sick|medical|on[- ]duty|\bod\b|absence/.test(text)) {
    if (/chemistry|subject/.test(text)) {
      return `The processed dataset provides section-wide weekly totals, not Chemistry-specific meetings or attendance. For ${current.section.name}, I can estimate the section aggregate only.`;
    }
    const duration = text.match(/\b(\d+)\s*[- ]?\s*(?:calendar\s*)?days?\b/);
    if (!duration) return "How many calendar days should I model? For example: 3-day medical leave starting tomorrow.";
    if (!/on[- ]duty|\bod\b/.test(text)) return "Medical leave is not available in this section's leave selector. Choose On-duty to simulate classes counted as attended.";
    const startDate = /tomorrow/.test(text)
      ? shiftISODate(localISODate(), 1)
      : (text.match(/\b20\d{2}-\d{2}-\d{2}\b/) || [])[0];
    if (!startDate) return "What date does the leave start? Say 'tomorrow' or use YYYY-MM-DD.";
    $("#manual-leave-start").value = startDate;
    $("#manual-leave-days").value = duration[1];
    $("#manual-leave-type").value = "od";
    const result = calculateManualLeave();
    if (!result) return $("#manual-leave-result").textContent;
    const threshold = /90\s*%|ninety/.test(text) ? 90 : 75;
    const below = result.projected < threshold;
    return `${current.section.name} aggregate: ${result.days} days (${formatDate(result.startDate)}–${formatDate(result.endDate)}) affect an estimated ${result.affected} class units. ${result.isMedical ? "Medical leave counted as missed" : "OD counted as attended"}. With all other future classes attended, projected end attendance is ${result.projected.toFixed(1)}%; this ${below ? "falls below" : "stays at or above"} ${threshold}%. Subject-specific schedule data is not available in this summary.`;
  }
  const attended = current.percentage * current.completed / 100;
  const need75 = Math.max(0, Math.ceil((75 - current.percentage) * current.completed / 25));
  const need90 = Math.max(0, Math.ceil((90 - current.percentage) * current.completed / 10));
  return `${current.section.name} aggregate is ${current.percentage.toFixed(1)}% over an estimated ${current.completed} completed classes (about ${attended.toFixed(1)} attended). ${need75 > current.remaining ? `75% is unreachable: ${need75} attended classes needed, ${current.remaining} estimated remain.` : `Attend ${need75} classes consecutively to reach 75%.`} ${need90 > current.remaining ? `90% needs ${need90}, but only ${current.remaining} remain.` : `Attend ${need90} consecutive classes to reach 90%.`} These are section-level estimates from weekly totals.`;
}

function addChatMessage(text, role) {
  const message = document.createElement("p");
  message.className = `chat-message ${role}`;
  message.textContent = text;
  $("#chat-log").append(message);
  $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
}

function bindAdvisorChat() {
  const panel = $("#advisor-chat");
  const toggle = $("#chat-toggle");
  const open = (isOpen) => {
    panel.hidden = !isOpen;
    toggle.setAttribute("aria-expanded", String(isOpen));
    if (isOpen) $("#chat-input").focus();
  };
  toggle.addEventListener("click", () => open(panel.hidden));
  $("#chat-close").addEventListener("click", () => open(false));
  $("#chat-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#chat-input");
    const question = input.value.trim();
    if (!question) return;
    addChatMessage(question, "user");
    addChatMessage(advisorReply(question), "bot");
    input.value = "";
  });
}

function renderSectionOptions(select, sections) {
  select.innerHTML = '<option value="">Choose a section</option>'
    + sections.map((section) => `<option value="${section.id}">${escapeHTML(section.name)} · ${escapeHTML(section.academic_year)}</option>`).join("")
      + `<optgroup label="Processed dataset sections">${SECTION_DATA.map((section) => `<option value="manual:${escapeHTML(section.name)}">${escapeHTML(section.name)} · ${section.weekly_classes} classes/week</option>`).join("")}</optgroup>`;
}

async function loadSections() {
  const select = $("#section-select");
  try {
    const response = await fetch("/static/section_counts.json");
    if (!response.ok) throw new Error("Could not load processed section counts");
    SECTION_DATA = await response.json();
    localStorage.setItem(SECTION_DATA_CACHE_KEY, JSON.stringify(SECTION_DATA));
  } catch {
    SECTION_DATA = JSON.parse(localStorage.getItem(SECTION_DATA_CACHE_KEY) || "[]");
  }
  try {
    const response = await fetch("/api/sections");
    if (!response.ok) throw new Error("Could not load sections");
    const sections = await response.json();
    localStorage.setItem(CACHE_KEY, JSON.stringify(sections));
    renderSectionOptions(select, sections);
    setConnection(true, sections.length ? "Sections loaded" : "No verified sections yet");
    if (sections.length) $("#empty-state").hidden = false;
  } catch {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "[]");
    renderSectionOptions(select, cached);
    setConnection(false, cached.length ? "Offline · saved sections" : "Offline · demo available");
  }
}

async function loadSection(sectionId, renderEmpty = true) {
  if (!sectionId) return;
  state.demo = false;
  state.manualSection = null;
  state.manualCalculation = null;
  state.sectionId = Number(sectionId);
  $("#manual-calculator").hidden = true;
  $("#dashboard").hidden = false;
  const planningDate = $("#planning-date").value;
  try {
    const response = await fetch(`/api/forecast?section_id=${encodeURIComponent(sectionId)}&planning_date=${encodeURIComponent(planningDate)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load forecast.");
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ id: sectionId, date: planningDate, payload }));
    setConnection(true, "Live section data");
    render(payload);
  } catch (error) {
    const cached = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "null");
    if (cached && String(cached.id) === String(sectionId)) {
      setConnection(false, "Offline · saved forecast");
      render(cached.payload);
    } else {
      setConnection(false, "Offline · no saved forecast");
      if (renderEmpty) {
        $("#dashboard").hidden = true;
        $("#empty-state").hidden = false;
        $("#source-note").hidden = false;
        $("#source-note").textContent = error.message;
      }
    }
  }
}

function formatDate(value) {
  if (!value) return "your selected date";
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function openDemo() {
  state.demo = true;
  state.manualSection = null;
  state.manualCalculation = null;
  state.sectionId = "demo";
  $("#section-select").value = "demo";
  $("#manual-calculator").hidden = true;
  $("#planning-date").value = TERM_END;
  setConnection(navigator.onLine, navigator.onLine ? "Synthetic demo" : "Offline · synthetic demo");
  render(makeDemo());
}

function openManualSection(name) {
  state.demo = false;
  state.sectionId = `manual:${name}`;
  state.manualSection = SECTION_DATA.find((item) => item.name === name) || null;
  state.manualCalculation = null;
  state.manualEffective = null;
  state.snapshot = null;
  $("#section-select").value = state.sectionId;
  $("#manual-section-title").textContent = name;
  $("#manual-percent").value = "";
  $("#manual-calculator").hidden = false;
  $("#dashboard").hidden = true;
  $("#empty-state").hidden = true;
  $("#detention-alert").hidden = true;
  $("#manual-result").hidden = true;
  setConnection(navigator.onLine, "Manual attendance mode");
}

function calculateManualAttendance() {
  const rawPercent = $("#manual-percent").value.trim();
  const percent = rawPercent === "" ? Number.NaN : Number(rawPercent);
  const result = $("#manual-result");
  const primary = $("#manual-primary");
  const detail = $("#manual-detail");
  const alert = $("#manual-alert");
  const dialog = $("#manual-alert-dialog");
  result.hidden = false;
  result.className = "manual-result";
  alert.hidden = true;
  if (dialog.open) dialog.close();

  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    primary.textContent = "Enter an attendance percentage from 0 to 100.";
    detail.textContent = "Percentages may include up to two decimal places.";
    state.manualCalculation = null;
    $("#manual-health-value").textContent = "—";
    $("#manual-health-bar").style.width = "0%";
    calculateManualLeave();
    return;
  }

  const today = localISODate();
  const section = SECTION_DATA.find((item) => item.name === $("#manual-section-title").textContent);
  const requestedDate = $("#planning-date").value;
  if (!section) {
    primary.textContent = "Section schedule data is unavailable.";
    detail.textContent = "Choose one of the sections in the processed dataset.";
    state.manualCalculation = null;
    calculateManualLeave();
    return;
  }
  if (!requestedDate || requestedDate > TERM_END || requestedDate < TERM_START) {
    primary.textContent = "Please select a date within the semester period.";
    detail.textContent = `Choose a date from ${TERM_START} through ${TERM_END}.`;
    state.manualCalculation = null;
    calculateManualLeave();
    return;
  }
  const todayInTerm = today < TERM_START ? TERM_START : today > TERM_END ? TERM_END : today;
  const completed = countSectionClasses(section, TERM_START, todayInTerm);
  const throughSelectedDate = countSectionClasses(section, TERM_START, requestedDate);
  const selectedFuture = Math.max(0, throughSelectedDate - completed);
  const remaining = Math.max(0, section.semester_classes - completed);
  const remainingAfterSelected = Math.max(0, section.semester_classes - throughSelectedDate);
  if (completed === 0) {
    primary.textContent = "No weekday class sessions have elapsed in this semester yet.";
    detail.textContent = "Try again after the semester begins on Aug 29, 2026.";
    state.manualCalculation = null;
    calculateManualLeave();
    return;
  }

  const percentHundredths = Math.round(percent * 100);
  const need75 = Math.max(0, Math.ceil(((7500 - percentHundredths) * completed) / 2500));
  const need90 = Math.max(0, Math.ceil(((9000 - percentHundredths) * completed) / 1000));
  const canReach75 = need75 <= remaining;
  const canReach90 = need90 <= remaining;
  const shownPercent = `${(percentHundredths / 100).toFixed(2).replace(/\.00$/, "")}%`;

  if (percentHundredths < 7500 && !canReach75) {
    result.classList.add("critical");
    primary.textContent = `Irreversible Detention: 75% is no longer reachable for ${$("#manual-section-title").textContent}.`;
    const alertCopy = `At ${shownPercent}, ${$("#manual-section-title").textContent} needs ${need75} consecutive attended classes to reach 75%, but only ${remaining} are scheduled after today through Nov 29, 2026.`;
    $("#manual-alert-copy").textContent = alertCopy;
    $("#manual-dialog-copy").textContent = alertCopy;
    alert.hidden = false;
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
  } else if (percentHundredths < 7500) {
    result.classList.add("warning");
    primary.textContent = `Attend ${need75} consecutive classes to reach 75% by semester end.`;
  } else if (percentHundredths < 9000) {
    result.classList.add("warning");
    primary.textContent = canReach90
      ? `Attend ${need90} consecutive classes to reach 90% by semester end.`
      : `90% needs ${need90} classes; only ${remaining} are scheduled this semester.`;
  } else {
    primary.textContent = "You are already at or above 90%.";
  }

  const recovery90 = need90 <= remaining
    ? `90% is reachable by semester end in ${need90} attended classes.`
    : `90% needs ${need90}; only ${remaining} classes remain this semester.`;
  const recovery75 = need75 <= remaining
    ? `75% is reachable by semester end in ${need75} attended classes.`
    : `75% needs ${need75}; only ${remaining} classes remain this semester.`;
  detail.textContent = `Processed dataset: ${section.weekly_classes} classes/week; ${section.semester_classes} total for semester. Estimated through today: ${completed}; through ${requestedDate}: ${throughSelectedDate}; after today to semester end: ${remaining}; after selected date: ${remainingAfterSelected}. Current attendance: ${shownPercent}. ${recovery75} ${recovery90} Partial-date counts are estimated by evenly distributing weekly classes across weekdays.`;
  state.manualCalculation = {
    section,
    percentage: percentHundredths / 100,
    completed,
    remaining,
    basePrimary: primary.textContent,
    baseDetail: detail.textContent,
  };
  state.manualEffective = { ...state.manualCalculation };
  const healthValue = $("#manual-health-value");
  const healthBar = $("#manual-health-bar");
  setManualHealth(percentHundredths / 100);
  calculateManualLeave();
}

function setManualHealth(percent) {
  const value = Math.max(0, Math.min(100, percent));
  const bar = $("#manual-health-bar");
  $("#manual-health-value").textContent = `${value.toFixed(1)}%`;
  bar.style.width = `${value}%`;
  bar.className = value < 75 ? "critical" : value < 90 ? "warning" : "safe";
  $(".manual-health-track").setAttribute("aria-valuenow", String(value));
}

function calculateManualLeave() {
  const output = $("#manual-leave-result");
  const current = state.manualCalculation;
  if (!current) {
    output.textContent = "Enter your percentage and calculate first.";
    return null;
  }
  const leaveType = $("#manual-leave-type").value;
  const alert = $("#manual-alert");
  const dialog = $("#manual-alert-dialog");
  if (leaveType === "none") {
    state.manualEffective = { ...current };
    setManualHealth(current.percentage);
    $("#manual-primary").textContent = current.basePrimary;
    $("#manual-detail").textContent = current.baseDetail;
    alert.hidden = true;
    if (dialog.open) dialog.close();
    output.textContent = "No leave selected; showing current attendance.";
    output.className = "manual-leave-result";
    return null;
  }
  const startDate = $("#manual-leave-start").value;
  const days = Number($("#manual-leave-days").value);
  if (!startDate || !Number.isInteger(days) || days < 1) {
    output.textContent = "Choose a future start date and positive whole number of days.";
    return null;
  }
  const endDate = shiftISODate(startDate, days - 1);
  if (startDate <= localISODate() || endDate > TERM_END) {
    output.textContent = "Leave dates must start after today and end by Nov 29, 2026.";
    return null;
  }
  const affected = Math.min(current.remaining, countSectionClasses(current.section, startDate, endDate));
  const isMedical = leaveType === "medical";
  const futureMissed = isMedical ? affected : 0;
  const futureAttended = current.remaining - futureMissed;
  const projected = projection(
    current.percentage * current.completed / 100,
    current.completed,
    futureAttended,
    futureMissed,
  );
  const classLabel = `${affected} estimated class${affected === 1 ? "" : "es"}`;
  const typeLabel = isMedical ? "medical leave counted as missed" : "OD counted as attended";
  output.textContent = `${days} calendar days affect ${classLabel}; ${typeLabel}. If you attend all other remaining classes, projected semester-end attendance is ${projected.toFixed(1)}%. Estimate uses section weekly totals distributed over weekdays.`;
  output.className = "manual-leave-result";
  if (projected < 75) output.classList.add("critical");
  else if (projected < 90) output.classList.add("warning");

  if (isMedical) {
    state.manualEffective = { ...current };
    setManualHealth(current.percentage);
    $("#manual-primary").textContent = current.basePrimary;
    $("#manual-detail").textContent = current.baseDetail;
    alert.hidden = true;
    if (dialog.open) dialog.close();
    return { affected, projected, isMedical, startDate, endDate, days };
  }

  const adjustedConducted = current.completed + affected;
  const adjustedAttended = current.percentage * current.completed / 100 + affected;
  const adjustedPercentage = adjustedAttended * 100 / adjustedConducted;
  const remainingAfterOD = Math.max(0, current.section.semester_classes - adjustedConducted);
  state.manualEffective = {
    ...current,
    percentage: adjustedPercentage,
    completed: adjustedConducted,
    remaining: remainingAfterOD,
  };
  const need75 = Math.max(0, Math.ceil((75 - adjustedPercentage) * adjustedConducted / 25));
  const need90 = Math.max(0, Math.ceil((90 - adjustedPercentage) * adjustedConducted / 10));
  const canReach75 = need75 <= remainingAfterOD;
  const canReach90 = need90 <= remainingAfterOD;
  setManualHealth(adjustedPercentage);
  alert.hidden = true;
  if (adjustedPercentage < 75 && !canReach75) {
    const alertCopy = `After counting ${affected} estimated On-Duty classes as attended, projected attendance is ${adjustedPercentage.toFixed(1)}%. You need ${need75} more classes to reach 75%, but only ${remainingAfterOD} are estimated to remain.`;
    $("#manual-primary").textContent = "Irreversible Detention: 75% is unreachable even after the planned OD.";
    $("#manual-alert-copy").textContent = alertCopy;
    $("#manual-dialog-copy").textContent = alertCopy;
    alert.hidden = false;
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
  } else {
    if (dialog.open) dialog.close();
    $("#manual-primary").textContent = adjustedPercentage < 75
      ? `After OD, attend ${need75} more classes to reach 75%.`
      : adjustedPercentage < 90
        ? `After OD, attend ${need90} more classes to reach 90%.`
        : "OD-adjusted attendance is at or above 90%.";
  }
  $("#manual-detail").textContent = `Planned OD adds ${affected} classes to attendance. Estimated attendance changes from ${current.percentage.toFixed(1)}% to ${adjustedPercentage.toFixed(1)}% after those dates; ${adjustedConducted} classes then counted, ${remainingAfterOD} estimated remain. ${canReach75 ? `75% needs ${need75} more attended classes.` : `75% needs ${need75}; only ${remainingAfterOD} remain.`} ${canReach90 ? `90% needs ${need90} more attended classes.` : `90% needs ${need90}; only ${remainingAfterOD} remain.`}`;
  return { affected, projected, isMedical, startDate, endDate, days };
}

function initialize() {
  const today = localISODate();
  $("#today-label").textContent = new Date(`${today}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  $("#planning-date").value = today > TERM_END ? TERM_END : today < TERM_START ? TERM_START : today;
  $("#planning-date").min = today < TERM_START ? TERM_START : today;
  $("#planning-date").max = TERM_END;
  $("#section-select").addEventListener("change", (event) => {
    const value = event.target.value;
    if (value.startsWith("manual:")) openManualSection(value.slice(7));
    else loadSection(value);
  });
  $("#manual-calculate").addEventListener("click", calculateManualAttendance);
  const leaveStart = $("#manual-leave-start");
  leaveStart.min = shiftISODate(today, 1);
  leaveStart.max = TERM_END;
  leaveStart.value = shiftISODate(today, 1);
  for (const control of [$("#manual-leave-type"), leaveStart, $("#manual-leave-days")]) {
    control.addEventListener("input", calculateManualLeave);
    control.addEventListener("change", calculateManualLeave);
  }
  $("#planning-date").addEventListener("change", () => {
    if (String(state.sectionId || "").startsWith("manual:")) calculateManualAttendance();
  });
  $("#manual-dialog-close").addEventListener("click", () => $("#manual-alert-dialog").close());
  $("#planning-date").addEventListener("change", () => {
    if (state.demo) render(state.snapshot);
    else if (state.sectionId && !String(state.sectionId).startsWith("manual:")) loadSection(state.sectionId);
  });
  bindAdvisorChat();
  window.addEventListener("online", () => { state.online = true; if (!state.demo) loadSections(); });
  window.addEventListener("offline", () => { state.online = false; setConnection(false, "Offline · local calculations"); });
  loadSections();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js").catch(() => {});
}

document.addEventListener("DOMContentLoaded", initialize);

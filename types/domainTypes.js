/**
 * Domain shape reference for the seawater tank app.
 *
 * These typedefs are documentation-only for now. Keeping them in one place
 * makes it easier to move to TypeScript later without changing app behavior.
 *
 * @typedef {{ min: number, max: number }} TargetRange
 * @typedef {{ name: string, volume: number, targets: Record<string, TargetRange>, targetInputs: Record<string, string> }} TankSettings
 * @typedef {{ kh: number, ca: number, mg: number, aplus: number, kplus: number, customName: string, customDose: number, lastSavedAt: string, status: Record<string, { enabled: boolean, pausedDays: number }> }} DosingSettings
 * @typedef {{ mode: string, modeLabel: string, rawValue: number, finalValue: number, formula: string }} MeasurementMethod
 * @typedef {{ id: string, date: string, kh: number, ca: number, mg: number, k: number, no3: number, po4: number, measuredFields?: Record<string, boolean>, measurementMethods?: Record<string, MeasurementMethod>, salinity?: number|string, temperature?: number|string, note?: string }} Measurement
 * @typedef {{ id: string, name: string, quantity: number, addedAt: string, removed: boolean, removedAt?: string }} FishEntry
 * @typedef {{ id: string, date: string, timesPerDay: number, amountLevel: string, foodTypes: string[], note?: string }} FeedingEntry
 * @typedef {{ id: string, date: string, item: string, doseMl: number, note?: string }} AdditiveEntry
 * @typedef {{ id: string, weekday: string, item: string, doseMl: number, enabled: boolean, note?: string }} AdditiveSchedule
 * @typedef {{ id: string, event_type: string, affected_element: "kh"|"ca"|"mg"|string, start_date: string, recovery_days: number, event_recovery_mode?: boolean, note?: string }} SystemEvent
 * @typedef {{ deadZone: number, withinDeadZone: boolean, stableLock: boolean, inTargetRange: boolean, inStabilityRange: boolean, consecutiveOutOfRange: number, hasConfirmedOutOfRange: boolean }} StabilityContext
 * @typedef {{ observe_mode: boolean, reasons: string[], adjustment_factor: number, observe_days: number }} ObserveContext
 * @typedef {{ id: string, tank: TankSettings, dosing: DosingSettings, records: Measurement[], archivedRecords: Measurement[], maintenance: object[], doseApplications: object[], livestock: FishEntry[], additives: AdditiveEntry[], additiveSchedules: AdditiveSchedule[], feedings: FeedingEntry[], events: SystemEvent[], uiState: object }} TankData
 */

export {};

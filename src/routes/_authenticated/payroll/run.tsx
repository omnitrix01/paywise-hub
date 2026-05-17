import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/app/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, Th, Td, EmptyState, TableSkeleton } from "@/components/app/Table";
import { calcPayroll, periodLabel } from "@/lib/payroll";
import { formatINR, monthName } from "@/lib/format";
import { Loader2, ChevronRight, ChevronLeft, CheckCircle2, ChevronDown } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/payroll/run")({ component: RunPayroll });

const STEPS = ["Period", "Employees", "Preview", "Finalize"] as const;

function daysOverlapInMonth(from: string, to: string, month: number, year: number): number {
  const start = new Date(Math.max(+new Date(from), +new Date(year, month - 1, 1)));
  const end = new Date(Math.min(+new Date(to), +new Date(year, month, 0)));
  if (end < start) return 0;
  return Math.floor((+end - +start) / 86400000) + 1;
}

function RunPayroll() {
  const navigate = useNavigate();
  const today = new Date();
  const [step, setStep] = useState(0);
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [year, setYear] = useState(today.getFullYear());
  const [workingDays, setWorkingDays] = useState(30);
  const [loading, setLoading] = useState(false);
  const [employees, setEmployees] = useState<any[]>([]);
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [lop, setLop] = useState<Record<string, number>>({});
  type LeaveDetail = {
    typeId: string;
    name: string;
    entitlement: number;
    priorUsed: number;
    remainingBefore: number;
    usedThisMonth: number;
    paid: number;
    lop: number;
    remainingAfter: number;
    unpaidType: boolean;
  };
  const [autoLop, setAutoLop] = useState<Record<string, { lop: number; paid: number; breakdown: string; details: LeaveDetail[] }>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (step !== 1 || employees.length) return;
    setLoading(true);
    (async () => {
      const [empRes, typesRes, reqRes] = await Promise.all([
        supabase
          .from("employees")
          .select("id, emp_id, full_name, designation, department, status, pf_applicable, esi_applicable, pt_applicable, employee_salary(ctc, effective_from)")
          .eq("status", "Active"),
        supabase.from("leave_types").select("id, name, annual_entitlement"),
        supabase.from("leave_requests").select("employee_id, leave_type_id, from_date, to_date, days, status").eq("status", "Approved"),
      ]);
      const data = empRes.data;
      const types = typesRes.data ?? [];
      const allReqs = reqRes.data ?? [];
      const list = (data ?? []).map((e: any) => ({
        ...e,
        ctc: (e.employee_salary ?? []).sort((a: any, b: any) => +new Date(b.effective_from) - +new Date(a.effective_from))[0]?.ctc ?? 0,
      }));
      setEmployees(list);
      const inc: Record<string, boolean> = {};
      const lopInit: Record<string, number> = {};
      const autoInit: Record<string, { lop: number; paid: number; breakdown: string; details: LeaveDetail[] }> = {};
      const typeById = new Map(types.map((t: any) => [t.id, t]));
      const isUnpaidType = (n: string) => /unpaid|lop|loss\s*of\s*pay/i.test(n ?? "");

      list.forEach((e) => {
        inc[e.id] = e.ctc > 0;
        // Approved leaves for this employee, all-time, for entitlement tracking
        const empReqs = allReqs.filter((r: any) => r.employee_id === e.id);
        // Prior usage (before this month) per type, to compute remaining balance
        const monthStart = new Date(year, month - 1, 1);
        const priorUsed = new Map<string, number>();
        for (const r of empReqs) {
          if (new Date(r.from_date) < monthStart) {
            // Count days that fell before the payroll month
            const days = Number(r.days) || 0;
            const inMonth = daysOverlapInMonth(r.from_date, r.to_date, month, year);
            const beforeMonth = Math.max(0, days - inMonth);
            priorUsed.set(r.leave_type_id, (priorUsed.get(r.leave_type_id) ?? 0) + beforeMonth);
          }
        }
        // Current month usage per type
        const monthUsage = new Map<string, number>();
        for (const r of empReqs) {
          const d = daysOverlapInMonth(r.from_date, r.to_date, month, year);
          if (d > 0) monthUsage.set(r.leave_type_id, (monthUsage.get(r.leave_type_id) ?? 0) + d);
        }
        let lopDays = 0;
        let paidDays = 0;
        const parts: string[] = [];
        const details: LeaveDetail[] = [];
        // Include all types so admins see remaining balance even when no leave was taken this month
        for (const t of types as any[]) {
          const used = monthUsage.get(t.id) ?? 0;
          const prior = priorUsed.get(t.id) ?? 0;
          const entitlement = t.annual_entitlement ?? 0;
          const remainingBefore = Math.max(0, entitlement - prior);
          const unpaid = isUnpaidType(t.name);
          let paid = 0, lop = 0;
          if (unpaid) { lop = used; }
          else { paid = Math.min(used, remainingBefore); lop = used - paid; }
          paidDays += paid; lopDays += lop;
          const remainingAfter = unpaid ? remainingBefore : Math.max(0, remainingBefore - paid);
          details.push({ typeId: t.id, name: t.name, entitlement, priorUsed: prior, remainingBefore, usedThisMonth: used, paid, lop, remainingAfter, unpaidType: unpaid });
          if (used > 0) {
            if (unpaid) parts.push(`${used}d ${t.name} (LOP)`);
            else if (paid > 0 && lop > 0) parts.push(`${paid}d ${t.name} + ${lop}d LOP (over balance)`);
            else if (lop > 0) parts.push(`${lop}d ${t.name} (LOP — no balance)`);
            else parts.push(`${paid}d ${t.name}`);
          }
        }
        lopInit[e.id] = lopDays;
        autoInit[e.id] = { lop: lopDays, paid: paidDays, breakdown: parts.join(" · "), details };
      });
      setIncluded(inc);
      setLop(lopInit);
      setAutoLop(autoInit);
      setLoading(false);
    })();
  }, [step, month, year]);

  // Reset cached data when period changes so leaves are re-fetched for the new month
  useEffect(() => { setEmployees([]); setLop({}); setAutoLop({}); }, [month, year]);

  const computed = useMemo(() => employees.filter((e) => included[e.id]).map((e) => ({
    emp: e,
    calc: calcPayroll({
      ctc: e.ctc, workingDays, lopDays: lop[e.id] ?? 0,
      pf_applicable: !!e.pf_applicable, esi_applicable: !!e.esi_applicable, pt_applicable: !!e.pt_applicable,
    }),
  })), [employees, included, lop, workingDays]);

  const totals = computed.reduce((acc, r) => ({ gross: acc.gross + r.calc.grossPay, net: acc.net + r.calc.netPay }), { gross: 0, net: 0 });

  const finalize = async () => {
    setBusy(true);
    const { data: existing } = await supabase.from("payroll_runs").select("id").eq("month", month).eq("year", year).maybeSingle();
    if (existing) { setBusy(false); return toast.error(`Payroll for ${periodLabel(month, year)} already exists`); }

    const { data: run, error } = await supabase.from("payroll_runs").insert({
      month, year, status: "Finalized", total_gross: totals.gross, total_net: totals.net, finalized_at: new Date().toISOString(),
    }).select().single();
    if (error || !run) { setBusy(false); return toast.error(error?.message ?? "Failed"); }

    const entries = computed.map((r) => ({
      run_id: run.id, employee_id: r.emp.id,
      working_days: workingDays, lop_days: lop[r.emp.id] ?? 0,
      gross_pay: r.calc.grossPay, net_pay: r.calc.netPay,
      pf_employee: r.calc.pf_employee, pf_employer: r.calc.pf_employer,
      esi_employee: r.calc.esi_employee, esi_employer: r.calc.esi_employer,
      pt: r.calc.pt, tds: r.calc.tds, other_deductions: 0,
      components_snapshot: r.calc.components_snapshot,
    }));
    const { error: e2 } = await supabase.from("payroll_entries").insert(entries);
    if (e2) { setBusy(false); return toast.error(e2.message); }

    const slips = computed.map((r) => ({
      run_id: run.id, employee_id: r.emp.id,
      payslip_data: {
        employee: { full_name: r.emp.full_name, emp_id: r.emp.emp_id, designation: r.emp.designation, department: r.emp.department },
        period: { month, year }, workingDays, lopDays: lop[r.emp.id] ?? 0,
        earnings: r.calc.earnings, deductions: r.calc.deductions,
        grossPay: r.calc.grossPay, totalDeductions: r.calc.totalDeductions, netPay: r.calc.netPay,
      },
    }));
    await supabase.from("payslips").insert(slips);

    setBusy(false);
    toast.success(`Payroll for ${periodLabel(month, year)} finalized`);
    navigate({ to: "/payroll/history" });
  };

  return (
    <div>
      <PageHeader title="Run Payroll" subtitle="Calculate and finalize payroll for the month" />

      <div className="card-elev p-1.5 mb-5 inline-flex gap-1">
        {STEPS.map((s, i) => (
          <div key={s} className={`px-4 py-1.5 rounded-md text-sm flex items-center gap-2 ${i === step ? "bg-primary text-primary-foreground" : i < step ? "text-primary" : "text-muted-foreground"}`}>
            {i < step ? <CheckCircle2 className="h-4 w-4" /> : <span className="h-5 w-5 rounded-full border flex items-center justify-center text-xs">{i + 1}</span>}
            {s}
          </div>
        ))}
      </div>

      <div className="card-elev p-6">
        {step === 0 && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-2xl">
            <div className="space-y-1.5"><label className="text-sm">Month</label>
              <select className="h-10 border rounded-md px-3 w-full text-sm" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
              </select></div>
            <div className="space-y-1.5"><label className="text-sm">Year</label>
              <Input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} /></div>
            <div className="space-y-1.5"><label className="text-sm">Working Days</label>
              <Input type="number" value={workingDays} onChange={(e) => setWorkingDays(Number(e.target.value))} /></div>
          </div>
        )}

        {step === 1 && (
          loading ? <TableSkeleton /> : employees.length === 0 ? (
            <EmptyState title="No active employees" description="Add employees with a CTC before running payroll." />
          ) : (
            <div>
              <div className="px-3 py-2 mb-3 text-xs bg-accent/40 border rounded-md text-muted-foreground">
                LOP days are auto-calculated from approved leave requests for {periodLabel(month, year)}. Leaves beyond annual entitlement and unpaid leave types count as LOP. Override per employee if needed.
              </div>
              <DataTable>
                <thead className="bg-muted/40"><tr><Th>Include</Th><Th>Employee</Th><Th>CTC (Annual)</Th><Th>Leave Summary</Th><Th>LOP Days</Th></tr></thead>
                <tbody className="divide-y">
                  {employees.map((e) => {
                    const auto = autoLop[e.id];
                    const current = lop[e.id] ?? 0;
                    const overridden = auto && current !== auto.lop;
                    const isOpen = !!expanded[e.id];
                    const hasDetails = !!auto?.details?.length;
                    return (
                      <>
                      <tr key={e.id}>
                        <Td><input type="checkbox" checked={!!included[e.id]} onChange={(ev) => setIncluded({ ...included, [e.id]: ev.target.checked })} /></Td>
                        <Td><div className="font-medium">{e.full_name}</div><div className="text-xs text-muted-foreground font-mono">{e.emp_id}{e.ctc === 0 && " · No CTC"}</div></Td>
                        <Td>{formatINR(e.ctc)}</Td>
                        <Td>
                          {auto && (auto.paid > 0 || auto.lop > 0) ? (
                            <div className="text-xs">
                              <div className="text-secondary-foreground">{auto.breakdown}</div>
                              <div className="text-muted-foreground mt-0.5">Paid: {auto.paid}d · LOP: {auto.lop}d</div>
                            </div>
                          ) : <span className="text-xs text-muted-foreground">No leaves</span>}
                          {hasDetails && (
                            <button type="button" onClick={() => setExpanded({ ...expanded, [e.id]: !isOpen })}
                              className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
                              <ChevronDown className={`h-3 w-3 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                              {isOpen ? "Hide" : "View"} entitlement breakdown
                            </button>
                          )}
                        </Td>
                        <Td>
                          <div className="flex items-center gap-2">
                            <Input type="number" min={0} max={workingDays} className="h-8 w-20" value={current} onChange={(ev) => setLop({ ...lop, [e.id]: Number(ev.target.value) })} />
                            {overridden && (
                              <button type="button" className="text-[11px] text-primary hover:underline" onClick={() => setLop({ ...lop, [e.id]: auto!.lop })}>Reset</button>
                            )}
                          </div>
                          {overridden && <div className="text-[11px] text-amber-600 mt-0.5">Overridden (auto: {auto!.lop})</div>}
                        </Td>
                      </tr>
                      {isOpen && hasDetails && (
                        <tr key={`${e.id}-detail`} className="bg-muted/20">
                          <Td className="!p-0" />
                          <Td className="!py-3" />
                          <Td className="!py-3" />
                          <Td className="!py-3" colSpan={2}>
                            <div className="rounded-md border bg-white">
                              <table className="w-full text-xs">
                                <thead className="bg-muted/40 text-muted-foreground">
                                  <tr>
                                    <th className="text-left px-3 py-2 font-medium">Leave Type</th>
                                    <th className="text-right px-3 py-2 font-medium">Entitlement</th>
                                    <th className="text-right px-3 py-2 font-medium">Used (prior)</th>
                                    <th className="text-right px-3 py-2 font-medium">Balance</th>
                                    <th className="text-right px-3 py-2 font-medium">This Month</th>
                                    <th className="text-right px-3 py-2 font-medium text-emerald-700">Paid</th>
                                    <th className="text-right px-3 py-2 font-medium text-amber-700">LOP</th>
                                    <th className="text-right px-3 py-2 font-medium">Balance After</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {auto.details.map((d) => (
                                    <tr key={d.typeId} className="border-t">
                                      <td className="px-3 py-2">
                                        {d.name}
                                        {d.unpaidType && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 rounded px-1">Unpaid</span>}
                                      </td>
                                      <td className="px-3 py-2 text-right">{d.unpaidType ? "—" : d.entitlement}</td>
                                      <td className="px-3 py-2 text-right text-muted-foreground">{d.unpaidType ? "—" : d.priorUsed}</td>
                                      <td className="px-3 py-2 text-right">{d.unpaidType ? "—" : d.remainingBefore}</td>
                                      <td className="px-3 py-2 text-right">{d.usedThisMonth || "—"}</td>
                                      <td className="px-3 py-2 text-right text-emerald-700 font-medium">{d.paid || "—"}</td>
                                      <td className="px-3 py-2 text-right text-amber-700 font-medium">{d.lop || "—"}</td>
                                      <td className="px-3 py-2 text-right">{d.unpaidType ? "—" : d.remainingAfter}</td>
                                    </tr>
                                  ))}
                                </tbody>
                                <tfoot className="bg-muted/20">
                                  <tr className="border-t">
                                    <td className="px-3 py-2 font-medium" colSpan={5}>Total</td>
                                    <td className="px-3 py-2 text-right font-semibold text-emerald-700">{auto.paid}</td>
                                    <td className="px-3 py-2 text-right font-semibold text-amber-700">{auto.lop}</td>
                                    <td className="px-3 py-2" />
                                  </tr>
                                </tfoot>
                              </table>
                            </div>
                          </Td>
                        </tr>
                      )}
                      </>
                    );
                  })}
                </tbody>
              </DataTable>
            </div>
          )
        )}

        {step === 2 && (
          <div>
            <div className="grid grid-cols-3 gap-4 mb-4">
              <Stat label="Employees" value={String(computed.length)} />
              <Stat label="Gross Payable" value={formatINR(totals.gross)} />
              <Stat label="Net Payable" value={formatINR(totals.net)} />
            </div>
            <DataTable>
              <thead className="bg-muted/40"><tr><Th>Employee</Th><Th className="text-right">Gross</Th><Th className="text-right">Deductions</Th><Th className="text-right">Net Pay</Th></tr></thead>
              <tbody className="divide-y">
                {computed.map((r) => (
                  <tr key={r.emp.id}>
                    <Td><div className="font-medium">{r.emp.full_name}</div><div className="text-xs text-muted-foreground font-mono">{r.emp.emp_id}</div></Td>
                    <Td className="text-right">{formatINR(r.calc.grossPay)}</Td>
                    <Td className="text-right text-destructive">{formatINR(r.calc.totalDeductions)}</Td>
                    <Td className="text-right font-semibold">{formatINR(r.calc.netPay)}</Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        )}

        {step === 3 && (
          <div className="text-center py-6">
            <CheckCircle2 className="h-12 w-12 text-emerald-500 mx-auto mb-3" />
            <h3 className="text-lg font-semibold">Ready to finalize</h3>
            <p className="text-sm text-muted-foreground mt-1">Finalizing payroll for <strong>{periodLabel(month, year)}</strong> across <strong>{computed.length}</strong> employees.</p>
            <p className="text-sm mt-2">Total Net Payable: <strong className="text-primary">{formatINR(totals.net)}</strong></p>
            <p className="text-xs text-muted-foreground mt-3">This action will create payslips and cannot be undone for the same month.</p>
          </div>
        )}

        <div className="flex justify-between mt-6 pt-4 border-t">
          <Button variant="outline" disabled={step === 0 || busy} onClick={() => setStep((s) => s - 1)}><ChevronLeft className="h-4 w-4 mr-1" /> Back</Button>
          {step < 3
            ? <Button onClick={() => setStep((s) => s + 1)} disabled={step === 1 && computed.length === 0}>Continue <ChevronRight className="h-4 w-4 ml-1" /></Button>
            : <Button onClick={finalize} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Finalize Payroll</Button>}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="border rounded-lg p-4"><div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div><div className="text-xl font-semibold mt-1">{value}</div></div>;
}
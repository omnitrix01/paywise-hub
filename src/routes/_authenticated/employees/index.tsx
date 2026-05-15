import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/app/PageHeader";
import { DataTable, Th, Td, StatusBadge, EmptyState, TableSkeleton } from "@/components/app/Table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, Users } from "lucide-react";
import { formatDate } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/employees/")({ component: EmployeesList });

function EmployeesList() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("");
  const [status, setStatus] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("employees").select("*").order("created_at", { ascending: false });
      setRows(data ?? []);
      setLoading(false);
    })();
  }, []);

  const departments = Array.from(new Set(rows.map((r) => r.department).filter(Boolean)));
  const filtered = rows.filter((r) => {
    const matchQ = !q || r.full_name?.toLowerCase().includes(q.toLowerCase()) || r.emp_id?.toLowerCase().includes(q.toLowerCase());
    const matchD = !dept || r.department === dept;
    const matchS = !status || r.status === status;
    return matchQ && matchD && matchS;
  });

  return (
    <div>
      <PageHeader
        title="Employees"
        subtitle={`${rows.length} total`}
        actions={<Button asChild><Link to="/employees/new"><Plus className="h-4 w-4 mr-1" /> Add Employee</Link></Button>}
      />

      <div className="card-elev">
        <div className="p-4 flex flex-wrap gap-3 items-center border-b">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search by name or employee ID" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select className="h-9 px-3 rounded-md border bg-background text-sm" value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">All Departments</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select className="h-9 px-3 rounded-md border bg-background text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All Status</option>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
          </select>
        </div>

        {loading ? (
          <TableSkeleton rows={6} cols={6} />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={rows.length === 0 ? "No employees yet" : "No matches"}
            description={rows.length === 0 ? "Add your first employee to get started." : "Try adjusting filters."}
            action={rows.length === 0 ? <Button asChild><Link to="/employees/new"><Plus className="h-4 w-4 mr-1" /> Add Employee</Link></Button> : null}
          />
        ) : (
          <DataTable>
            <thead className="bg-muted">
              <tr>
                <Th>Emp ID</Th><Th>Name</Th><Th>Department</Th><Th>Designation</Th>
                <Th>Date of Joining</Th><Th>Type</Th><Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-t cursor-pointer" onClick={() => navigate({ to: "/employees/$id", params: { id: r.id } })}>
                  <Td className="font-mono text-xs">{r.emp_id}</Td>
                  <Td className="font-medium">{r.full_name}</Td>
                  <Td>{r.department ?? "—"}</Td>
                  <Td>{r.designation ?? "—"}</Td>
                  <Td>{formatDate(r.date_of_joining)}</Td>
                  <Td>{r.employment_type}</Td>
                  <Td><StatusBadge status={r.status === "Active" ? "active" : "inactive"}>{r.status}</StatusBadge></Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>
    </div>
  );
}
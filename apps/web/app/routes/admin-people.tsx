import { useState } from "react";
import { Form, useNavigation, useSubmit } from "react-router";
import { Trash2 } from "lucide-react";
import { requireAdmin } from "../lib/auth.server";
import type { Route } from "./+types/admin-people";
import {
  getAllPeople,
  getAllOrganizations,
  createPerson,
  updatePerson,
  addMembership,
  deleteMembership,
} from "../services/admin";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { FilterBar } from "../components/ui/filter-bar";
import { NativeSelect } from "../components/ui/native-select";
import { PageHeader } from "../components/ui/page-header";
import { SearchField } from "../components/ui/search-field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";

export async function loader({ request }: { request: Request }) {
  await requireAdmin(request);
  const supabase = getSupabaseAdminClient();
  const [people, organizations] = await Promise.all([
    getAllPeople(supabase),
    getAllOrganizations(supabase),
  ]);
  return { people, organizations };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const supabase = getSupabaseAdminClient();
  const formData = await request.formData();
  const intent = formData.get("intent");

  try {
    if (intent === "create_person") {
      const name = formData.get("name") as string;
      await createPerson(supabase, name);
    } else if (intent === "update_person") {
      const id = formData.get("id") as string;
      const name = formData.get("name") as string;
      const is_councillor = formData.get("is_councillor") === "on";
      await updatePerson(supabase, id, { name, is_councillor });
    } else if (intent === "add_membership") {
      const person_id = formData.get("person_id") as string;
      const organization_id = formData.get("organization_id") as string;
      const role = formData.get("role") as string;
      const start_date = (formData.get("start_date") as string) || undefined;
      const end_date = (formData.get("end_date") as string) || undefined;

      await addMembership(supabase, {
        person_id: parseInt(person_id),
        organization_id: parseInt(organization_id),
        role,
        start_date,
        end_date,
      });
    } else if (intent === "delete_membership") {
      const id = formData.get("id") as string;
      await deleteMembership(supabase, id);
    }
    return { success: true };
  } catch (e: any) {
    return { error: e.message };
  }
}

const fieldLabel = "mb-1.5 block text-sm text-zinc-600";

export default function AdminPeople({ loaderData }: Route.ComponentProps) {
  const { people, organizations } = loaderData;
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedPerson, setSelectedPerson] = useState<any>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const submit = useSubmit();
  const navigation = useNavigation();

  const filteredPeople = people.filter((p) =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const handleEdit = (person: any) => {
    setSelectedPerson(person);
    setIsDialogOpen(true);
  };

  const handleClose = () => {
    setIsDialogOpen(false);
    setSelectedPerson(null);
  };

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-5xl px-4 py-12">
        <PageHeader
          title="People"
          description="Manage people, council members and memberships."
          actions={
            <Dialog>
              <DialogTrigger asChild>
                <Button>Add person</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add person</DialogTitle>
                </DialogHeader>
                <Form method="post" className="space-y-4">
                  <input type="hidden" name="intent" value="create_person" />
                  <div>
                    <label htmlFor="new-person-name" className={fieldLabel}>
                      Full name
                    </label>
                    <Input id="new-person-name" name="name" required />
                  </div>
                  <Button type="submit" className="w-full">
                    Create
                  </Button>
                </Form>
              </DialogContent>
            </Dialog>
          }
        />

        <FilterBar
          search={
            <SearchField
              value={searchTerm}
              onValueChange={setSearchTerm}
              placeholder="Search people"
              aria-label="Search people"
            />
          }
          status={
            <span className="tabular-nums">
              {searchTerm
                ? `${filteredPeople.length.toLocaleString()} of ${people.length.toLocaleString()} people`
                : `${people.length.toLocaleString()} people`}
            </span>
          }
        />

        {filteredPeople.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
            {searchTerm
              ? `No people match "${searchTerm}".`
              : "No people recorded yet. Add one to get started."}
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-2xl border border-zinc-200 bg-surface shadow-sm">
            {filteredPeople.map((person) => (
              <li
                key={person.id}
                className="flex items-start gap-3 px-4 py-2.5 hover:bg-zinc-50/60"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-zinc-900">
                      {person.name}
                    </span>
                    {person.is_councillor && (
                      <Badge variant="brand">Council</Badge>
                    )}
                  </div>
                  {person.memberships?.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {person.memberships.map((m: any) => (
                        <Badge key={m.id} variant="muted" className="font-normal">
                          {m.role} · {m.organization?.name}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-zinc-600"
                  onClick={() => handleEdit(person)}
                  aria-label={`Edit ${person.name}`}
                >
                  Edit
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{selectedPerson?.name ?? "Edit person"}</DialogTitle>
          </DialogHeader>

          {selectedPerson && (
            <div className="space-y-6">
              <Form method="post" className="space-y-4">
                <input type="hidden" name="intent" value="update_person" />
                <input type="hidden" name="id" value={selectedPerson.id} />
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                  <div>
                    <label htmlFor="edit-person-name" className={fieldLabel}>
                      Name
                    </label>
                    <Input
                      id="edit-person-name"
                      name="name"
                      defaultValue={selectedPerson.name}
                    />
                  </div>
                  <label
                    htmlFor="is_councillor"
                    className="flex h-9 items-center gap-2 text-sm text-zinc-700"
                  >
                    <input
                      type="checkbox"
                      name="is_councillor"
                      id="is_councillor"
                      defaultChecked={selectedPerson.is_councillor}
                      className="h-4 w-4 rounded border-zinc-300 accent-brand-600"
                    />
                    Councillor or mayor
                  </label>
                </div>
                <Button type="submit" variant="outline" size="sm">
                  Save details
                </Button>
              </Form>

              <section className="space-y-3 border-t border-zinc-100 pt-6">
                <h3 className="text-sm font-semibold text-zinc-900">
                  Memberships
                </h3>

                {!selectedPerson.memberships?.length ? (
                  <div className="rounded-xl border border-dashed border-zinc-300 bg-surface/60 p-4 text-sm text-zinc-500">
                    No memberships recorded.
                  </div>
                ) : (
                  <ul className="max-h-56 divide-y divide-zinc-100 overflow-y-auto rounded-xl border border-zinc-200">
                    {selectedPerson.memberships.map((m: any) => (
                      <li
                        key={m.id}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                      >
                        <div className="min-w-0">
                          <div className="text-zinc-900">
                            <span className="font-medium">{m.role}</span>
                            <span className="text-zinc-500">
                              {" "}
                              · {m.organization?.name}
                            </span>
                          </div>
                          <div className="text-xs tabular-nums text-zinc-500">
                            {m.start_date || "Unknown start"} –{" "}
                            {m.end_date || "present"}
                          </div>
                        </div>
                        <Form method="post">
                          <input
                            type="hidden"
                            name="intent"
                            value="delete_membership"
                          />
                          <input type="hidden" name="id" value={m.id} />
                          <Button
                            type="submit"
                            variant="ghost"
                            size="icon-sm"
                            className="text-zinc-400 hover:bg-red-50 hover:text-red-700"
                            aria-label={`Remove ${m.role} membership at ${m.organization?.name ?? "organization"}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </Form>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                  <h4 className="mb-3 text-sm font-medium text-zinc-900">
                    Add membership
                  </h4>
                  <Form method="post" className="grid gap-3 sm:grid-cols-2">
                    <input type="hidden" name="intent" value="add_membership" />
                    <input
                      type="hidden"
                      name="person_id"
                      value={selectedPerson.id}
                    />

                    <div className="sm:col-span-2">
                      <label htmlFor="membership-org" className={fieldLabel}>
                        Organization
                      </label>
                      <NativeSelect
                        id="membership-org"
                        name="organization_id"
                        required
                        defaultValue=""
                      >
                        <option value="" disabled>
                          Select an organization
                        </option>
                        {organizations.map((org) => (
                          <option key={org.id} value={org.id}>
                            {org.name} ({org.classification})
                          </option>
                        ))}
                      </NativeSelect>
                    </div>

                    <div className="sm:col-span-2">
                      <label htmlFor="membership-role" className={fieldLabel}>
                        Role
                      </label>
                      <Input
                        id="membership-role"
                        name="role"
                        placeholder="e.g. Member, Chair"
                        required
                      />
                    </div>

                    <div>
                      <label htmlFor="membership-start" className={fieldLabel}>
                        Start date
                      </label>
                      <Input
                        id="membership-start"
                        name="start_date"
                        type="date"
                      />
                    </div>
                    <div>
                      <label htmlFor="membership-end" className={fieldLabel}>
                        End date
                      </label>
                      <Input id="membership-end" name="end_date" type="date" />
                    </div>

                    <div className="sm:col-span-2">
                      <Button type="submit" size="sm">
                        Add membership
                      </Button>
                    </div>
                  </Form>
                </div>
              </section>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

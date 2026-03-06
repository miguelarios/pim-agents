import ical from "ical-generator";
import * as nodeIcal from "node-ical";

export interface ParsedEvent {
  uid: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  status?: string;
  transparency?: string;
  attendees?: Array<{ name?: string; email: string; status?: string }>;
  organizer?: { name?: string; email: string };
  recurrenceRule?: string;
  created?: string;
  lastModified?: string;
}

export interface EventCreateProps {
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  attendees?: Array<{ email: string; name?: string }>;
}

export function parseIcsEvents(icsContent: string): ParsedEvent[] {
  if (!icsContent.trim()) return [];

  const parsed = nodeIcal.parseICS(icsContent);
  const events: ParsedEvent[] = [];

  for (const component of Object.values(parsed)) {
    if (component.type !== "VEVENT") continue;
    const vevent = component as nodeIcal.VEvent;

    const attendees: Array<{
      name?: string;
      email: string;
      status?: string;
    }> = [];
    if (vevent.attendee) {
      const attendeeList = Array.isArray(vevent.attendee) ? vevent.attendee : [vevent.attendee];
      for (const att of attendeeList) {
        const email =
          typeof att === "string"
            ? att.replace("mailto:", "")
            : (att.val || "").replace("mailto:", "");
        const name = typeof att === "string" ? undefined : att.params?.CN;
        attendees.push({ email, name });
      }
    }

    let organizer: { name?: string; email: string } | undefined;
    if (vevent.organizer) {
      const org = vevent.organizer;
      organizer = {
        email: (typeof org === "string" ? org : org.val || "").replace("mailto:", ""),
        name: typeof org === "string" ? undefined : org.params?.CN,
      };
    }

    events.push({
      uid: vevent.uid || "",
      summary: vevent.summary || "",
      start: vevent.start ? new Date(vevent.start).toISOString() : "",
      end: vevent.end ? new Date(vevent.end).toISOString() : "",
      location: vevent.location,
      description: vevent.description,
      status: vevent.status?.toUpperCase(),
      transparency: vevent.transparency?.toUpperCase(),
      attendees: attendees.length > 0 ? attendees : undefined,
      organizer,
      recurrenceRule: vevent.rrule?.toString(),
      created: vevent.created ? new Date(vevent.created).toISOString() : undefined,
      lastModified: vevent.lastmodified ? new Date(vevent.lastmodified).toISOString() : undefined,
    });
  }

  return events;
}

export function generateEventIcs(props: EventCreateProps): string {
  const calendar = ical({ name: "cal-mcp" });

  const eventOptions: Parameters<typeof calendar.createEvent>[0] = {
    start: new Date(props.start),
    end: new Date(props.end),
    summary: props.summary,
  };
  if (props.location) eventOptions.location = props.location;
  if (props.description) eventOptions.description = props.description;

  const event = calendar.createEvent(eventOptions);

  if (props.attendees) {
    for (const att of props.attendees) {
      event.createAttendee({ email: att.email, name: att.name });
    }
  }

  return calendar.toString();
}

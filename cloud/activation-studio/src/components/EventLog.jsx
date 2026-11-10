import "./EventLog.css";

export default function EventLog({ entries }) {
  return (
    <div className="event-log">
      <h2>Event log</h2>
      <ul>
        {entries.map((e) => (
          <li key={e.id}>
            <span className="event-time">{e.t}</span> <span className="event-msg">{e.text}</span>
          </li>
        ))}
      </ul>
      {entries.length === 0 && <p className="event-empty">Move the visitor into a radius to trigger rules.</p>}
    </div>
  );
}

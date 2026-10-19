# Volkswagen ID.

This integration shows the data of your Volkswagen ID. electric cars (ID.3,
ID.4, ID.5, ID.7, ID. Buzz…) in Gladys. It uses Volkswagen's **EU Data Act
portal** with the account of the **Volkswagen** smartphone app. No box to
install.

> **Why the EU Data Act portal?** Since 2026-06-01, Volkswagen has closed to
> third-party applications the access the ID. app uses. The EU Data Act
> portal is the only source still open. It is **read-only**, and Volkswagen
> publishes a snapshot of the car there **every 15 minutes** at best. So the
> integration cannot start the charge or the climatisation, nor lock the
> car.

## What you get

One device per car linked to the portal, with:

| Value                   | Note                |
| ----------------------- | ------------------- |
| Battery level (%)       |                     |
| Range (km)              |                     |
| Charging                |                     |
| Charging power (kW)     |                     |
| Charging cable plugged  |                     |
| Charge limit (%)        |                     |
| Remaining charging time | only while charging |
| Outside temperature     |                     |
| Odometer                |                     |
| Door / window open      |                     |
| Locked                  |                     |

A value the car has not sent yet is left out.

## Step 1: enable the EU Data Act portal (once, in a browser)

1. Open <https://eu-data-act.drivesomethinggreater.com/> and sign in with the
   account of the Volkswagen app. Accept the terms if the portal shows them.
2. Go to **Data clusters → Vehicle overview**. If your car is not listed,
   click **Connect your car** and follow the steps.
3. Click **Get customised data**.
4. Tick the agreement under article 4 of the EU Data Act, then **Next**.
5. Tick **All data**.
6. Name the request, for example "Gladys".
7. Pick the **every 15 minutes** frequency and **no end date**.
8. Send the request.

The first data arrives 15 minutes to a few hours later. The car must be awake
to send any: drive, charge, or open the Volkswagen app.

## Step 2: configure the integration

1. In Gladys, open the **Configuration** tab of the integration and enter the
   **email address** and the **password** of the Volkswagen account.
2. The **refresh interval** sets how often new data is checked: every
   5 minutes by default, every 3 minutes at most. Volkswagen only publishes a
   snapshot every 15 minutes: going lower is pointless.
3. Save, then click **Test the connection**. The message lists the cars found
   and whether data is already available.
4. Add your cars from the **Discovery** tab.

The password stays in Gladys. The integration writes nothing to disk.

## Scenes

The integration adds its own cards to the scene editor (Gladys 5.1 or later),
under the **Integrations** category:

- **Charge completed** (trigger) — starts the scene when a car has finished
  charging because its battery reached the charge limit. Optionally pick the
  car. The following actions can read `{{triggerEvent.data.battery_level}}`
  and `{{triggerEvent.data.range}}`. With a snapshot every 15 minutes, the
  event can come up to a quarter of an hour after the charge actually ended.

The car values are regular Gladys devices too: a scene can, for example, warn
you when the car is left unlocked in the evening.

## Dashboard

Add the **Volkswagen ID.** widget to a dashboard and pick the car (the first
of the account by default). It shows the battery and the range live, and the
state of the charge, the cable, the locks and the openings. The **Refresh**
button checks right away whether Volkswagen published new data.

The **Volkswagen ID. picture** widget shows the same values around the
picture Volkswagen holds for your car: your model, in its colour. When
Volkswagen has no picture of your car, the widget says so instead of showing a
generic image.

Both widgets show the name you gave the car when adding it to Gladys (else its
nickname in the Volkswagen app).

## Troubleshooting

- **"Volkswagen sign-in refused"** — check the email address and the password
  by signing in to the portal in a browser. After a refusal, the integration
  waits 15 minutes before trying again, so the account does not get locked.
- **"Sign in once to the Volkswagen EU Data Act portal…"** — the portal was
  never opened with this account, or it waits for you to accept its terms:
  do step 1.
- **"No data reaches Gladys yet: enable the continuous data request…"** —
  step 1 is not finished (points 3 to 8).
- **Values stuck** — the car is asleep and the portal only receives empty
  snapshots: values come back once the car drives or charges.

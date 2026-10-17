# Volkswagen ID.

This integration connects Gladys to your Volkswagen ID. electric cars (ID.3,
ID.4, ID.5, ID.7, ID. Buzz…) through the Volkswagen cloud, with the account
of the **Volkswagen** smartphone app. No box to install: Gladys reads the car
the way the app does.

## What you get

One device per car of the account, with, depending on the car's equipment:

| Value                     | Read | Control                        |
| ------------------------- | :--: | ------------------------------ |
| Battery level (%)         |  ✔︎   |                                |
| Electric range (km)       |  ✔︎   |                                |
| Battery temperature       |  ✔︎   |                                |
| Charging                  |  ✔︎   | start / stop the charge        |
| Charging power (kW)       |  ✔︎   |                                |
| Charging cable plugged    |  ✔︎   |                                |
| Charge limit (%)          |  ✔︎   | 50 to 100 %, by steps of 10    |
| Remaining charging time   |  ✔︎   |                                |
| Climatisation             |  ✔︎   | start / stop                   |
| Climatisation temperature |  ✔︎   | 16 to 29.5 °C, by steps of 0.5 |
| Outside temperature       |  ✔︎   |                                |
| Odometer                  |  ✔︎   |                                |
| Door / window open        |  ✔︎   |                                |
| Locked                    |  ✔︎   | lock / unlock (S-PIN)          |

A value the car does not report (service not activated, licence expired) is
left out.

## Configuration

1. Check that your car is added to the account of the **Volkswagen** app and
   that you accepted the latest terms in the app.
2. In Gladys, open the **Configuration** tab of the integration and enter the
   **email address** and the **password** of that account.
3. Optional: the **S-PIN** (the 4-digit code set in the app), only to lock and
   unlock the car remotely.
4. The **refresh interval** sets how often each car is read: every 5 minutes
   by default, every 3 minutes at most. Volkswagen limits the number of
   requests per account: do not go lower, especially if other tools use the
   same account.
5. Save, then click **Test the connection**: the message lists the cars found.
6. Add your cars from the **Discovery** tab.

The password and the S-PIN stay in Gladys. The integration only keeps the
Volkswagen session tokens in its private volume, so that a restart does not
sign in again.

## Actions

- **Test the connection** — signs in to the account and lists the cars.
- **Wake up a car** — a parked car falls asleep and stops reporting; this
  action asks it to send a fresh status (it arrives within a few minutes).
  Use it sparingly: every wake-up draws on the 12 V battery.

## Scenes

The integration adds its own cards to the scene editor (Gladys 5.1 or later),
under the **Integrations** category:

- **Charge completed** (trigger) — starts the scene when a car stops charging
  because its battery reached the charge limit. Optionally pick the car. The
  following actions can read `{{triggerEvent.data.battery_level}}` and
  `{{triggerEvent.data.range}}` (for a message like "ID.3 charged to 80 %,
  350 km").

The car values are regular Gladys devices too: a scene can, for example,
start the climatisation at 7:30 on weekdays, or warn you when the car is
left unlocked at night.

## Dashboard

Add the **Volkswagen ID.** widget to a dashboard and pick the car (the first
of the account by default). It shows the battery and the range live, the
state of the charge, the cable, the climatisation and the locks, and offers
buttons to start or stop the climatisation and the charge, and to refresh.

## Good to know

- After a command, the requested value shows right away; the car is read
  again about a minute later to confirm it.
- Volkswagen offers no official API: the integration uses the same service
  as the app, as documented by the open-source WeConnect / CarConnectivity
  projects. A change on Volkswagen's side can break it until the next update.

## Troubleshooting

- **"Volkswagen sign-in refused"** — check the email address and the
  password by signing in to the Volkswagen app. After a refusal, the
  integration waits 15 minutes before trying again, so the account does not
  get locked.
- **"Volkswagen asks you to accept new terms"** — open the Volkswagen app,
  sign in and accept them.
- **Values stuck** — the car is asleep: use **Wake up a car**, or wait for it
  to drive or charge.
- **429 errors in the logs** — too many requests on the account: raise the
  refresh interval.

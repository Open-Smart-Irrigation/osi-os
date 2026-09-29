# Fictional sensor record

The demo uses a fixed 90-day record ending 29 September 2026 at 09:00 UTC
(12:00 in Kampala). A separate agent acting as a senior agronomy reviewer proposed
and reviewed the sequence. It is a demonstration scenario, not measured MUARIK
field data or a calibrated soil model. The last seven days retain the detailed
sequence below; the preceding record provides coherent 30- and 90-day chart views.

Higher positive soil water tension means drier soil. Sensors at different depths
help distinguish shallow wetting from deeper changes; interpretation depends on
soil and placement. This follows the general measurement guidance in
[University of Minnesota Extension’s sensor guide](https://extension.umn.edu/natural-resources/conservation/agricultural-soil-and-water/irrigation/soil-moisture-sensors-for-irrigation-scheduling).
The exact event amounts, response delays and curve anchors below are fictional.

## Event sequence

Times below are UTC. Both nearby zones observe the same rainfall. Flow readings
represent their separate meters, never estimates from valve duration.

| Date and time | Rain in each zone | Tomato irrigation | Bed irrigation |
| --- | --- | --- | --- |
| 23 Sep, 15:30–17:30 | 14 mm | 0 L | 0 L |
| 25 Sep, 17:00–18:00 | 0 mm | 700 L | 0 L |
| 28 Sep, 18:00–19:15 | 0 mm | 0 L | 800 L |
| 29 Sep, 02:00–03:30 | 6 mm | 0 L | 0 L |
| 29 Sep, 05:45–06:15 | 0 mm | 0 L | 80 L |
| 29 Sep, 06:30–07:00 | 0 mm | 120 L | 0 L |

### Earlier chart record

The older record uses the same rules: rain is shared by both nearby gauges, while
flow is measured separately at each zone. Each wetting event has a shallow response
first and a later 40 cm response; dry periods rise more during daylight. These are
the additional event totals used by the 30- and 90-day chart views.

| Date | Shared rain | Tomato flow | Bed flow |
| --- | ---: | ---: | ---: |
| 4 Jul | 11 mm | 0 L | 0 L |
| 10 Jul | 0 mm | 650 L | 600 L |
| 17 Jul | 18 mm | 0 L | 0 L |
| 25 Jul | 0 mm | 750 L | 700 L |
| 3 Aug | 9 mm | 0 L | 0 L |
| 12 Aug | 0 mm | 0 L | 850 L |
| 19 Aug | 16 mm | 0 L | 0 L |
| 28 Aug | 0 mm | 750 L | 0 L |
| 6 Sep | 12 mm | 0 L | 0 L |
| 14 Sep | 0 mm | 0 L | 700 L |
| 20 Sep | 10 mm | 0 L | 0 L |

Each event is split into sampled 15-minute intervals. Confirmed dry intervals have
zero rain; this does not change the production rule that missing data stays
missing. Daily counters reset at midnight in Africa/Kampala. The current water
cards show 6 mm in each zone, with 120 L in Tomato and 80 L in the bed.

## Soil and environmental response

Between wetting events, tension rises, with more change during daylight. After
the main rain and irrigation events, the 20 cm channel drops first; the 40 cm
channel responds later. Small irregular variation keeps the curves from looking
like perfect ramps. Values at each story anchor remain reproducible.

The current Tomato channels are 56 and 46 kPa; the bed channels are 12 and 35 kPa.
The bed’s recent irrigation explains its wetter profile. The small final irrigation
runs do not cause an immediate deep response. The GUI’s existing colours classify
less than 20 kPa as wet, 20–50 as moist, and above 50 as dry. These are display
categories, not crop-specific watering prescriptions. The restored Action tile maps these
fictional categories to irrigate, delay or monitor and labels the result as
simulated sensor advice. It does not call a production prediction service.

Temperature and humidity have opposing day/night cycles. Light falls to zero at
night, and rain intervals reduce light and temperature while increasing humidity.
These are local sensor histories. The demo supplies no forecast, ET0 or crop-demand
calculation.

Use the soil chart’s **7 d**, **30 d**, and **90 d** buttons to show exact subsets of
the same 15-minute samples, and switch depth to compare responses. Presenter valve
commands do not rewrite historical readings. Reset restores the same record every
time.

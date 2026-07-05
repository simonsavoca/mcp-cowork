"""
Connecteur Pronote — Collège de la Mauldre (Lise SAVOCA, 4G)
Auth : ENT ecollege78 (EduConnect) via pronotepy

Variables d'env :
  EDUCONNECT_LOGIN      simon.savoca
  EDUCONNECT_PASSWORD   ...
  PRONOTE_QR_PIN        0603
"""
import sys
sys.stdout.reconfigure(encoding="utf-8")

import pronotepy
from pronotepy import ent
import datetime, os, uuid, json

LOGIN = os.environ["EDUCONNECT_LOGIN"]
PASS  = os.environ["EDUCONNECT_PASSWORD"]
PIN   = os.environ.get("PRONOTE_QR_PIN", "0603")


def connect():
    client = pronotepy.ParentClient(
        "https://0780709x.index-education.net/pronote/parent.html",
        username=LOGIN,
        password=PASS,
        ent=ent.ent_ecollege78,
        account_pin=PIN,
        client_identifier=str(uuid.uuid4()),
        device_name="MAIA",
    )
    lise = next(c for c in client.children if "Lise" in c.name or "SAVOCA" in c.name)
    client.set_child(lise)
    return client


def get_grades(client):
    result = {}
    for period in client.periods:
        grades = period.grades
        if not grades:
            continue
        result[period.name] = [
            {
                "subject": g.subject.name,
                "grade": g.grade,
                "out_of": g.out_of,
                "coefficient": g.coefficient,
                "date": g.date.isoformat() if g.date else None,
                "comment": g.comment,
            }
            for g in grades
        ]
    return result


def get_timetable(client, days=7):
    start = datetime.date.today()
    end   = start + datetime.timedelta(days=days)
    lessons = client.lessons(start, end)
    return [
        {
            "start": l.start.isoformat(),
            "end": l.end.isoformat(),
            "subject": l.subject.name if l.subject else None,
            "teacher": l.teacher_name,
            "room": l.classroom,
            "canceled": l.canceled,
            "status": l.status,
        }
        for l in sorted(lessons, key=lambda l: l.start)
    ]


def get_absences(client):
    result = {}
    for period in client.periods:
        try:
            absences = client.absences(period)
            if absences:
                result[period.name] = [
                    {
                        "from": a.from_date.isoformat(),
                        "to": a.to_date.isoformat(),
                        "justified": a.justified,
                        "reason": getattr(a, "reason", None),
                    }
                    for a in absences
                ]
        except Exception:
            pass
    return result


def get_bulletin(client):
    result = {}
    for period in client.periods:
        try:
            averages = period.averages
            if not averages:
                continue
            result[period.name] = {
                "moyennes": [
                    {
                        "matiere": a.subject.name,
                        "moyenne_eleve": str(a.student),
                        "moyenne_classe": str(a.class_average),
                        "min_classe": str(a.min),
                        "max_classe": str(a.max),
                    }
                    for a in averages
                ],
                "moyenne_generale": str(period.overall_average) if period.overall_average else None,
            }
        except Exception:
            pass
    return result


def get_homework(client, days=14):
    start = datetime.date.today()
    end   = start + datetime.timedelta(days=days)
    hw = client.homework(start, end)
    return [
        {
            "date": d.date.isoformat(),
            "subject": d.subject.name if d.subject else None,
            "description": d.description,
            "done": d.done,
        }
        for d in sorted(hw, key=lambda x: x.date)
    ]


def main():
    client = connect()

    data = {
        "eleve": client.children[0].name,
        "periodes": [p.name for p in client.periods],
        "notes": get_grades(client),
        "bulletin": get_bulletin(client),
        "edt": get_timetable(client),
        "absences": get_absences(client),
        "devoirs": get_homework(client),
    }

    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

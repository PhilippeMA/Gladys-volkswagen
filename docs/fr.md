# Volkswagen ID.

Cette intégration affiche dans Gladys les données de vos voitures électriques
Volkswagen de la gamme ID. (ID.3, ID.4, ID.5, ID.7, ID. Buzz…). Elle utilise
le **portail EU Data Act** de Volkswagen et le compte de l'application
smartphone **Volkswagen**. Aucun boîtier à installer.

> **Pourquoi le portail EU Data Act ?** Depuis le 1er juin 2026, Volkswagen
> a fermé aux applications tierces l'accès utilisé par l'application ID. Le
> portail EU Data Act est la seule source encore ouverte. Il est en
> **lecture seule** et Volkswagen y publie un relevé de la voiture **toutes
> les 15 minutes** au mieux. L'intégration ne peut donc ni lancer la charge
> ni la climatisation, ni verrouiller la voiture.

## Ce que vous obtenez

Un appareil par voiture liée au portail, avec :

| Donnée                   | Remarque                     |
| ------------------------ | ---------------------------- |
| Niveau de batterie (%)   |                              |
| Autonomie (km)           |                              |
| Charge en cours          |                              |
| Puissance de charge (kW) |                              |
| Câble de charge branché  |                              |
| Limite de charge (%)     |                              |
| Temps de charge restant  | seulement pendant une charge |
| Température extérieure   |                              |
| Kilométrage              |                              |
| Porte / vitre ouverte    |                              |
| Verrouillage             |                              |

Une donnée que la voiture n'a pas encore transmise n'apparaît pas.

## Étape 1 : activer le portail EU Data Act (une seule fois, dans un navigateur)

1. Ouvrez <https://eu-data-act.drivesomethinggreater.com/> et connectez-vous
   avec le compte de l'application Volkswagen. Acceptez les conditions si le
   portail vous les présente.
2. Allez dans **Data clusters → Vehicle overview**. Si votre voiture n'est
   pas listée, cliquez sur **Connect your car** et suivez les étapes.
3. Cliquez sur **Get customised data** (demander des données
   personnalisées).
4. Cochez l'accord prévu par l'article 4 de l'EU Data Act, puis **Next**.
5. Cochez **All data** (toutes les données).
6. Donnez un nom à la demande, par exemple « Gladys ».
7. Choisissez la fréquence **toutes les 15 minutes** et **pas de date de
   fin**.
8. Envoyez la demande.

Les premières données arrivent entre 15 minutes et quelques heures plus
tard. La voiture doit être réveillée pour en envoyer : roulez, chargez, ou
ouvrez l'application Volkswagen.

## Étape 2 : configurer l'intégration

1. Dans Gladys, ouvrez l'onglet **Configuration** de l'intégration et
   renseignez l'**adresse e-mail** et le **mot de passe** du compte
   Volkswagen.
2. L'**intervalle de rafraîchissement** règle la fréquence de vérification
   des nouvelles données : toutes les 5 minutes par défaut, toutes les
   3 minutes au plus. Volkswagen ne publie un relevé que toutes les
   15 minutes : inutile de descendre plus bas.
3. Enregistrez, puis cliquez sur **Tester la connexion**. Le message indique
   les voitures trouvées et si des données sont déjà disponibles.
4. Ajoutez vos voitures depuis l'onglet **Découverte**.

Le mot de passe reste dans Gladys. L'intégration n'écrit rien sur le disque.

## Scènes

L'intégration ajoute ses propres cartes à l'éditeur de scènes (Gladys 5.1
ou plus récent), dans la catégorie **Intégrations** :

- **Charge terminée** (déclencheur) — lance la scène quand une voiture a
  fini de charger parce que sa batterie a atteint la limite de charge.
  Choisissez éventuellement la voiture. Les actions suivantes peuvent lire
  `{{triggerEvent.data.battery_level}}` et `{{triggerEvent.data.range}}`.
  Avec un relevé toutes les 15 minutes, l'événement peut arriver jusqu'à un
  quart d'heure après la fin réelle de la charge.

Les données de la voiture sont aussi des appareils Gladys classiques : une
scène peut par exemple vous prévenir si la voiture n'est pas verrouillée le
soir.

## Tableau de bord

Ajoutez le widget **Volkswagen ID.** à un tableau de bord et choisissez la
voiture (la première du compte par défaut). Il affiche en direct la batterie
et l'autonomie, ainsi que l'état de la charge, du câble, du verrouillage et
des ouvrants. Le bouton **Actualiser** vérifie tout de suite si Volkswagen a
publié de nouvelles données.

Le widget **Volkswagen ID. en image** montre les mêmes informations autour
d'une image de votre voiture. Volkswagen ne fournit pas cette image à Gladys :
le portail EU Data Act n'en a pas, et le service d'images de l'application
Volkswagen est fermé aux applications tierces. Fournissez-la vous-même :

1. Prenez une image de votre voiture, par exemple une capture d'écran de
   l'application Volkswagen, recadrée sur la voiture.
2. Réduisez-la à **300 Ko au plus**, au format PNG, JPEG ou WebP (Gladys
   refuse les images plus lourdes). Une largeur de 800 pixels suffit.
3. Mettez-la en ligne à une adresse **https** publique, par exemple dans un
   dépôt GitHub (lien « Raw » du fichier).
4. Collez cette adresse dans le champ **Image de la voiture** de l'onglet
   Configuration, puis enregistrez.

L'intégration télécharge l'image une fois, sans y envoyer aucun identifiant
Volkswagen. Sans adresse, le widget l'indique au lieu d'afficher une image
générique ; si l'image ne peut pas être affichée (trop lourde, adresse
introuvable…), le widget le signale et les logs donnent la raison. Avec
plusieurs voitures sur le compte, la même image sert pour toutes.

Les deux widgets affichent le nom que vous avez donné à la voiture en
l'ajoutant dans Gladys (à défaut, son surnom dans l'application Volkswagen).

## Dépannage

- **« Connexion Volkswagen refusée »** — vérifiez l'adresse e-mail et le mot
  de passe en vous connectant au portail dans un navigateur. Après un refus,
  l'intégration attend 15 minutes avant de réessayer, pour ne pas faire
  bloquer le compte.
- **« Connectez-vous une fois au portail EU Data Act… »** — le portail n'a
  jamais été ouvert avec ce compte, ou il attend que vous acceptiez ses
  conditions : faites l'étape 1.
- **« Aucune donnée n'arrive encore : activez la demande de données
  continue… »** — l'étape 1 n'est pas terminée (points 3 à 8).
- **Valeurs figées** — la voiture dort et le portail ne reçoit que des
  relevés vides : elles reviennent quand la voiture roule ou charge.

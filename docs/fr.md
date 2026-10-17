# Volkswagen ID.

Cette intégration relie Gladys à vos voitures électriques Volkswagen de la
gamme ID. (ID.3, ID.4, ID.5, ID.7, ID. Buzz…) via le cloud Volkswagen, avec
le compte de l'application smartphone **Volkswagen**. Aucun boîtier à
installer : Gladys lit la voiture comme le fait l'application.

## Ce que vous obtenez

Un appareil par voiture du compte, avec selon l'équipement de la voiture :

| Donnée                       | Lecture | Commande                            |
| ---------------------------- | :-----: | ----------------------------------- |
| Niveau de batterie (%)       |    ✔︎    |                                     |
| Autonomie électrique (km)    |    ✔︎    |                                     |
| Température de la batterie   |    ✔︎    |                                     |
| Charge en cours              |    ✔︎    | lancer / arrêter la charge          |
| Puissance de charge (kW)     |    ✔︎    |                                     |
| Câble de charge branché      |    ✔︎    |                                     |
| Limite de charge (%)         |    ✔︎    | 50 à 100 %, par pas de 10           |
| Temps de charge restant      |    ✔︎    |                                     |
| Climatisation                |    ✔︎    | lancer / arrêter                    |
| Température de climatisation |    ✔︎    | 16 à 29,5 °C, par pas de 0,5        |
| Température extérieure       |    ✔︎    |                                     |
| Kilométrage                  |    ✔︎    |                                     |
| Porte / vitre ouverte        |    ✔︎    |                                     |
| Verrouillage                 |    ✔︎    | verrouiller / déverrouiller (S-PIN) |

Une donnée que la voiture ne remonte pas (service non activé, licence
expirée) n'apparaît pas.

## Configuration

1. Vérifiez que votre voiture est bien ajoutée au compte de l'application
   **Volkswagen** et que vous avez accepté les dernières conditions
   d'utilisation dans l'application.
2. Dans Gladys, ouvrez l'onglet **Configuration** de l'intégration et
   renseignez l'**adresse e-mail** et le **mot de passe** de ce compte.
3. Facultatif : le **S-PIN** (code à 4 chiffres défini dans l'application),
   uniquement pour verrouiller et déverrouiller la voiture à distance.
4. L'**intervalle de rafraîchissement** règle la fréquence de lecture de
   chaque voiture : toutes les 5 minutes par défaut, toutes les 3 minutes au
   plus. Volkswagen limite le nombre de requêtes par compte : ne descendez
   pas plus bas, surtout si vous utilisez d'autres outils sur le même compte.
5. Enregistrez, puis cliquez sur **Tester la connexion** : le message liste
   les voitures trouvées.
6. Ajoutez vos voitures depuis l'onglet **Découverte**.

Le mot de passe et le S-PIN restent dans Gladys. L'intégration conserve
seulement les jetons de session Volkswagen dans son volume privé, pour ne
pas se reconnecter à chaque redémarrage.

## Actions

- **Tester la connexion** — se connecte au compte et liste les voitures.
- **Réveiller une voiture** — une voiture garée s'endort et ne remonte plus
  ses valeurs ; cette action lui demande d'envoyer un état frais (il arrive
  d'ici quelques minutes). À utiliser avec modération : chaque réveil sollicite
  la batterie 12 V.

## Scènes

L'intégration ajoute ses propres cartes à l'éditeur de scènes (Gladys 5.1
ou plus récent), dans la catégorie **Intégrations** :

- **Charge terminée** (déclencheur) — lance la scène quand une voiture
  arrête de charger parce que sa batterie a atteint la limite de charge.
  Choisissez éventuellement la voiture. Les actions suivantes peuvent lire
  `{{triggerEvent.data.battery_level}}` et `{{triggerEvent.data.range}}`
  (par exemple pour un message « ID.3 chargée à 80 %, 350 km »).

Les données de la voiture sont aussi des appareils Gladys classiques : une
scène peut par exemple démarrer la climatisation à 7 h 30 les jours de
semaine, ou prévenir si la voiture est déverrouillée la nuit.

## Tableau de bord

Ajoutez le widget **Volkswagen ID.** à un tableau de bord et choisissez la
voiture (la première du compte par défaut). Il affiche en direct la batterie
et l'autonomie, l'état de la charge, du câble, de la climatisation et du
verrouillage, et propose des boutons pour lancer ou arrêter la
climatisation et la charge, et pour actualiser l'état.

## Bon à savoir

- Après une commande, la valeur demandée s'affiche tout de suite ; la
  voiture est relue environ une minute plus tard pour confirmer.
- Volkswagen ne propose pas d'API officielle : l'intégration utilise le
  même service que l'application, documenté par les projets open source
  WeConnect / CarConnectivity. Un changement côté Volkswagen peut la casser
  jusqu'à la mise à jour suivante.

## Dépannage

- **« Connexion Volkswagen refusée »** — vérifiez l'adresse e-mail et le mot
  de passe en vous connectant à l'application Volkswagen. Après un refus,
  l'intégration attend 15 minutes avant de réessayer, pour ne pas faire
  bloquer le compte.
- **« Volkswagen demande d'accepter de nouvelles conditions »** — ouvrez
  l'application Volkswagen, connectez-vous et acceptez-les.
- **Valeurs figées** — la voiture dort : utilisez **Réveiller une voiture**,
  ou attendez qu'elle roule ou charge.
- **Erreurs 429 dans les logs** — trop de requêtes sur le compte :
  augmentez l'intervalle de rafraîchissement.

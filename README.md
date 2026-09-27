# Backend "Coup d'Envoi"

Petit serveur qui appelle l'API-Football à ta place, met les résultats en cache
60 secondes (pour ne pas exploser ton quota gratuit), et renvoie des données
simplifiées prêtes à afficher.

## Déployer depuis ton téléphone (sans ordinateur), via Render.com

1. **Mets ce dossier sur GitHub**
   - Crée un compte sur [github.com](https://github.com) si besoin.
   - Crée un nouveau dépôt (bouton "+" → "New repository"), nomme-le par exemple
     `coup-denvoi-backend`.
   - Utilise l'option "upload files" dans l'interface web de GitHub (marche
     très bien depuis le navigateur mobile) pour envoyer les 3 fichiers :
     `package.json`, `server.js`, `.env.example` (ne mets jamais ton vrai
     `.env` sur GitHub).

2. **Crée un compte sur [render.com](https://render.com)** (gratuit)
   - "New +" → "Web Service"
   - Connecte ton compte GitHub, choisis le dépôt `coup-denvoi-backend`
   - Render détecte automatiquement Node.js
   - Build command : `npm install`
   - Start command : `npm start`
   - Plan : Free

3. **Ajoute ta clé API en variable d'environnement**
   - Dans les réglages du service Render → "Environment"
   - Ajoute `RAPIDAPI_KEY` avec ta vraie clé RapidAPI
   - Render redémarre automatiquement le service

4. **Récupère l'URL**
   - Render te donne une URL du type `https://coup-denvoi-backend.onrender.com`
   - Teste dans ton navigateur :
     `https://coup-denvoi-backend.onrender.com/api/fixtures?league=39&season=2026`
   - Tu dois voir du JSON avec la liste des matchs

## Limite du plan gratuit Render
Le service "s'endort" après 15 minutes sans requête, et met quelques secondes
à se relancer au premier appel suivant. Pour un prototype, c'est très bien ;
pour une vraie app publique, il faudra un plan payant plus tard.

## Rappel important
Ce backend ne peut pas être appelé depuis la page publiée sur claude.ai
(restriction de sécurité de l'environnement). Il est prêt pour le jour où
l'app tourne ailleurs : app mobile native, ou site web hébergé en dehors de
Claude.

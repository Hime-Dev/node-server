const express = require('express')
const router = express.Router()
const fs = require('fs')
const Path = require('path')
const Sequelize = require('sequelize')
const check_permission = require('../../middlewares/check_permission')
const sendDiscordEmbed = require('../../methods/discord_embed')
const error_messages = require("../../config/error_messages")
const MangaEpisode = require('../../models/MangaEpisode')

const { clearMangaFolder, deleteMangaFolder, getPath } = require('../../methods/manga-episode')
const { LogAddMangaEpisode, LogUpdateMangaEpisode, LogDeleteMangaEpisode } = require("../../methods/database_logs")
const { GeneralAPIRequestsLimiter } = require('../../middlewares/rate-limiter')

const multer = require('multer');


const manga_storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const { manga_slug, episode_number } = req.body
        const path = getPath(manga_slug, episode_number)
        if (!fs.existsSync(path)) fs.mkdirSync(path, { recursive: true })
        cb(null, path)
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname)
    }
})

const upload = multer({
    storage: manga_storage,
    fileFilter: function (req, file, callback) {
        var ext = Path.extname(file.originalname);
        if (ext !== '.png' && ext !== '.jpg' && ext !== '.gif' && ext !== '.jpeg') {
            return callback(new Error('Bu menüden sadece "png", "jpg", "gif" ve "jpeg" uzantılı dosyalar ekleyebilirsiniz.'))
        }
        callback(null, true)
    }
}).array('manga_pages')



// @route   GET api/manga-bolum/bolum-ekle
// @desc    Add manga chapters to service
// @access  Private
router.post('/bolum-ekle', async (req, res) => {
    let username, user_id

    try {
        const check_res = await check_permission(req.headers.authorization, "add-manga-episode")
        username = check_res.username
        user_id = check_res.user_id
    } catch (err) {
        return res.status(403).json({ 'err': err })
    }

    upload(req, res, async function (err) {
        if (err) {
            return res.status(500).json({ err: err.message })
        }
        const { manga_id, manga_slug, credits, episode_number, episode_name } = req.body
        let files = []

        try {
            const episode = await MangaEpisode.findOne({ raw: true, where: { manga_id: manga_id, episode_number: episode_number } })

            if (episode) return res.status(500).json({ 'err': error_messages.manga_episode_exists })
        } catch (err) {
            return console.log(err)
        }

        await clearMangaFolder(manga_slug, episode_number, req.files)

        req.files.forEach(file => {
            files.push({
                filename: file.originalname,
                mimetype: file.mimetype,
                size: file.size
            })
        })

        try {
            const result = await MangaEpisode.create({
                manga_id: manga_id ? manga_id : "",
                credits: credits ? credits : "",
                episode_name: episode_name ? episode_name : "",
                episode_number: episode_number ? episode_number : "",
                pages: files,
                created_by: user_id
            })

            LogAddMangaEpisode({
                process_type: 'add-manga-episode',
                username: username,
                manga_episode_id: result.id
            })

            sendDiscordEmbed({
                type: "manga-episode",
                manga_id,
                credits,
                episode_name,
                episode_number
            })

            return res.status(200).json({ 'success': 'success' })
        } catch (err) {
            console.log(err)
            return res.status(500).json({ 'err': error_messages.database_error })
        }
    })
})

// @route   POST api/manga-bolum/bolum-guncelle
// @desc    Update manga episode (perm: "update-manga-episode")
// @access  Private
router.post('/bolum-guncelle', async (req, res) => {
    let username
    const { credits, episode_name, id } = req.body

    try {
        const check_res = await check_permission(req.headers.authorization, "update-manga-episode")
        username = check_res.username
    } catch (err) {
        return res.status(403).json({ 'err': err })
    }

    try {
        await MangaEpisode.update({
            episode_name: episode_name,
            credits: credits
        }, { where: { id: id } })

        LogUpdateMangaEpisode({
            process_type: 'update-manga-episode',
            username: username,
            manga_episode_id: id
        })

        return res.status(200).json({ 'success': 'success' })
    } catch (err) {
        console.log(err)
        return res.status(500).json({ 'err': error_messages.database_error })
    }
})

// @route   GET api/manga-bolum/bolum-sil
// @desc    Delete episode (perm: "delete-episode")
// @access  Private
router.post('/bolum-sil', async (req, res) => {
    const { episode_id } = req.body

    let username
    try {
        const check_res = await check_permission(req.headers.authorization, "delete-manga-episode")
        username = check_res.username
    } catch (err) {
        return res.status(403).json({ 'err': err })
    }

    try {
        const { manga_name, manga_slug, episode_number, pages } = await MangaEpisode.findOne({
            raw: true,
            attributes: [
                '*',
                [
                    Sequelize.literal(`(
                    SELECT name
                    FROM manga
                    WHERE
                        id = manga_episode.manga_id
                )`),
                    'manga_name'
                ],
                [
                    Sequelize.literal(`(
                    SELECT slug
                    FROM manga
                    WHERE
                        id = manga_episode.manga_id
                )`),
                    'manga_slug'
                ]
            ], where: { id: episode_id }
        })

        Promise.all([deleteMangaFolder(manga_slug, episode_number, pages), MangaEpisode.destroy({ where: { id: episode_id } })])

        LogDeleteMangaEpisode({
            process_type: 'delete-manga-episode',
            username: username,
            episode_number: episode_number,
            manga_name: manga_name
        })

        return res.status(200).json({ 'success': 'success' })
    } catch (err) {
        console.log(err)
        return res.status(500).json({ 'err': 'Bir şeyler yanlış gitti.' })
    }
})

// @route   GET api/manga-bolum/:slug/read
// @desc    Get image paths and other stuff for reading page
// @access  Public
router.get('/:slug/read', GeneralAPIRequestsLimiter, async (req, res) => {
    let manga
    const { slug } = req.params

    try {
        manga = await MangaEpisode.findAll({
            attributes: [
                'id',
                'episode_number',
                'episode_name',
                'credits',
                'pages',
                [
                    Sequelize.literal(`(
                        SELECT name
                        FROM manga
                        WHERE
                            id = manga_episode.manga_id
                    )`),
                    'manga_name'
                ],
                [
                    Sequelize.literal(`(
                        SELECT cover_art
                        FROM manga
                        WHERE
                            id = manga_episode.manga_id
                    )`),
                    'manga_cover'
                ],
                [
                    Sequelize.literal(`(
                        SELECT name
                        FROM user
                        WHERE
                            id = manga_episode.created_by
                    )`),
                    'created_by'
                ]
            ],
            order: [[Sequelize.fn('ABS', Sequelize.col('episode_number'))]],
            where: {
                manga_id: {
                    [Sequelize.Op.eq]: Sequelize.literal(`(
                        SELECT id
                        FROM manga
                        WHERE
                        slug = "${slug}"
                        )`)
                }
            }
        })

        if (manga.length === 0) {
            return res.status(404).json({ 'err': 'Görüntülemek istediğiniz mangayı bulamadık.' });
        } else {
            res.json(manga);
        }
    } catch (err) {
        console.log(err)
        return res.status(500).json({ 'err': error_messages.database_error })
    }
})

module.exports = router;
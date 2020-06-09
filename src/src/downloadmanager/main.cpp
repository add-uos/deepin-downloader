#include <DApplication>
#include <DMainWindow>
#include <DWidgetUtil>
#include <DApplicationSettings>
#include <QTranslator>
#include <QClipboard>
#include <QCommandLineParser>
#include "mainframe.h"
#include "log.h"
DWIDGET_USE_NAMESPACE

int main(int argc, char *argv[])
{
    DApplication::loadDXcbPlugin();
    QGuiApplication::setAttribute(Qt::AA_UseHighDpiPixmaps);
    DApplication a(argc, argv);
    a.setQuitOnLastWindowClosed(false);
    a.loadTranslator();//加载程序的翻译文件
    a.setOrganizationName("uos");//设置公司名
    a.setApplicationName("downloadmanager");//设置应用程序名
    a.setApplicationVersion("1.0.00");//设置应用程序版本
    a.setProductIcon(QIcon(":/icons/icon/downloader4.svg"));//从系统主题中获取图标并设置成产品图标
    auto download_manager_name = QObject::tr("Download Manager");
    a.setProductName(download_manager_name);//设置产品的名称

    auto download_manager_info = QObject::tr("This is a download manage application.");
    a.setApplicationDescription(download_manager_info);//设置产品的描述信息

    a.setApplicationDisplayName(QCoreApplication::translate("Main", "Uos Download Management Application"));//设置应用程序的显示信息


    if (!a.setSingleInstance("downloadmanager"))//设置成单例程序
    {
        QClipboard *_c = QApplication::clipboard();
        //处理命令行类
        QCommandLineParser parser;
        parser.process(a);
        QStringList _comList = parser.positionalArguments();
        //发送以.torrent结尾文件
        for (int i = 0; i < _comList.size(); i++)
        {
            if(_comList[i].endsWith(".torrent"))
            {
                 _c->setText(_comList[i]);
            }
        }
        return 0;
    }


    QLocale locale;
    QTranslator translator; //新建翻译类
    QString strFileName = ""; // qm文件名称
    switch (locale.language()) // 取得当前系统语言，设置相关qm文件名称
    {
        case QLocale::Chinese:
        {
            strFileName = "downloadmanager.qm";
            break;
        }
        default:
            break;
    }

    if(strFileName.isEmpty() == false)
    {
        translator.load(strFileName); //导入生成的文件
        a.installTranslator(&translator); //装入
    }

    // 保存程序的窗口主题设置
    DApplicationSettings as;
    Q_UNUSED(as)
    QDir dirCheck;
    QString Log_path = QString("%1/%2/%3/Log/")
        .arg(QStandardPaths::writableLocation(QStandardPaths::ConfigLocation))
        .arg(qApp->organizationName())
        .arg(qApp->applicationName());

    setLogDir(Log_path);
    if (!dirCheck.exists(Log_path))
    {
        dirCheck.mkpath(Log_path);
    }
    //检查日志是否过期
    CheckLogTime();
    //磁盘剩余空间小于阈值，清除早期日志
    CheckFreeDisk();
    //创建新日志
    CreateNewLog();
    qInstallMessageHandler(customLogMessageHandler);

    qDebug()<<Log_path;//QStandardPaths::displayName(QStandardPaths::ConfigLocation);
    MainFrame w;
    w.show();


    Dtk::Widget::moveToCenter(&w);
    return a.exec();
}
